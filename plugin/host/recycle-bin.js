// ============================================================
//  host/recycle-bin.js — 回收站持久化层
//
//  做的事:
//    1. 任何任务完成 (成功/失败/late/aborted) 都归档到 dataFolder/recycle_bin/
//    2. 提供查询 / 取图 / 智能贴回 / 删除 / 清空 5 个核心 API
//
//  存储结构:
//    dataFolder/recycle_bin/
//      index.json                   — 元数据索引 (轻量, 按 createdAt 倒序)
//      <taskId>.png                 — 原图 (成功的任务才有)
//      <taskId>_thumb.jpg           — 200x200 缩略图 (列表用, 加载快)
//
//  设计要点:
//    - 完全跨 host 重启持久 (重启 PS 后还能在回收站看到历史)
//    - index.json 写入串行化; UXP rename 不可靠, 用 .bak + 主文件覆盖提供崩溃恢复
//    - 失败/aborted 任务也归档, 留 prompt + 报错信息, 方便用户回看
// ============================================================

function createRecycleBinModule(deps) {
    var fs = deps.fs;                    // uxp.storage.localFileSystem
    var storage = deps.storage;          // uxp.storage
    var base64ToArrayBuffer = deps.base64ToArrayBuffer;
    var arrayBufferToBase64 = deps.arrayBufferToBase64;
    var encodeJPEGFromRGB = deps.encodeJPEGFromRGB;   // 用 ps-pixels 的 jpeg 编码做缩略图
    var logToPanel = deps.logToPanel;

    var BIN_DIR_NAME = 'recycle_bin';
    var INDEX_FILE = 'index.json';
    var INDEX_BACKUP_FILE = INDEX_FILE + '.bak';
    var MAX_INDEX_ITEMS = 10000;          // 索引硬上限 (防失控), 不限大小但限条数
    // 单条提示词存储上限: 等于生成提示词的最大长度 (20000 字), 因此任何真实提示词
    // 都不会被截断 (修复"长提示词在回收站被砍到 2000 字"); 仍保留上限防异常数据撑爆 index.json。
    var MAX_PROMPT_CHARS = 20000;

    // 缓存 index, 减少磁盘 IO. 启动时加载, 写时同步刷盘
    var _index = null;
    var _indexLoading = null;
    var _binFolder = null;

    // 所有会同时改索引和图片文件的操作共用一条队列。某个操作失败后队列仍继续，
    // 避免 archive/delete/clear 在 await 文件 IO 时互相穿插，最终删错项或覆盖索引。
    var _mutationQueue = Promise.resolve();
    function _enqueueMutation(work) {
        var result = _mutationQueue.then(work, work);
        _mutationQueue = result.then(function() {}, function() {});
        return result;
    }

    function _serializeMutation(work) {
        return function() {
            var args = arguments;
            return _enqueueMutation(function() {
                return work.apply(null, args);
            });
        };
    }

    async function _getBinFolder() {
        if (_binFolder) return _binFolder;
        var dataFolder = await fs.getDataFolder();
        try {
            _binFolder = await dataFolder.getEntry(BIN_DIR_NAME);
        } catch(_) {
            _binFolder = await dataFolder.createFolder(BIN_DIR_NAME);
        }
        return _binFolder;
    }

    async function _loadIndex() {
        if (_index) return _index;
        if (_indexLoading) return await _indexLoading;
        _indexLoading = (async function() {
            var folder = await _getBinFolder();
            var loadedFromBackup = false;
            try {
                // 主文件只要完整有效就一定更新；.bak 可能只是上次删除失败留下的旧副本。
                var f = await folder.getEntry(INDEX_FILE);
                var txt = await f.read();
                var arr = JSON.parse(txt);
                if (!Array.isArray(arr)) throw new Error('索引内容不是数组');
                _index = arr;
            } catch(mainErr) {
                try {
                    // 只有主文件缺失或损坏时才使用完整备份恢复。
                    var bak = await folder.getEntry(INDEX_BACKUP_FILE);
                    var bakTxt = await bak.read();
                    var bakArr = JSON.parse(bakTxt);
                    if (!Array.isArray(bakArr)) throw new Error('备份内容不是数组');
                    _index = bakArr;
                    loadedFromBackup = true;
                } catch(_) {
                    _index = [];
                }
            }
            if (loadedFromBackup && logToPanel) {
                logToPanel('[回收站] 检测到未完成写入，已从备份恢复', 'warn');
            }
            _indexLoading = null;
            return _index;
        })();
        return await _indexLoading;
    }

    async function _saveIndex(options) {
        if (!_index) return;
        options = options || {};
        // 立即写盘会让此前已经触发但尚未执行的 debounce 失效，不能让旧任务随后反盖。
        if (!options.fromDebounce) _cancelDebouncedSave();
        else if (options.version !== _saveVersion) return;

        var folder = await _getBinFolder();
        // 限制条目上限, 防失控 (超出后从尾部砍掉, 不删图文件 — 用户手动清理才清)
        var toSave = _index;
        if (toSave.length > MAX_INDEX_ITEMS) toSave = toSave.slice(0, MAX_INDEX_ITEMS);
        var serialized = JSON.stringify(toSave);
        try {
            // UXP 的 rename 在目标已存在时不可靠。先写一份完整备份，再覆盖主文件；
            // 若主文件写到一半失败，备份会保留并在下次启动时被 _loadIndex 恢复。
            try {
                var bak = await folder.createFile(INDEX_BACKUP_FILE, { overwrite: true });
                await bak.write(serialized);
            } catch(backupErr) {
                // 没有一份完整备份时绝不覆盖主索引。宁可这次变更稍后重试，
                // 也不要在磁盘异常时把唯一可读的 index.json 一并破坏。
                if (logToPanel) logToPanel('[回收站] 备份索引写入失败，已保留原主索引: ' + backupErr.message, 'warn');
                return;
            }
            var f = await folder.createFile(INDEX_FILE, { overwrite: true });
            await f.write(serialized);
            try {
                var doneBak = await folder.getEntry(INDEX_BACKUP_FILE);
                await doneBak.delete();
            } catch(_) {}
        } catch(e) {
            if (logToPanel) logToPanel('[回收站] 索引写入失败: ' + e.message, 'warn');
        }
    }

    // 防抖版: 批量归档时(批处理一口气几十张)把 N 次全量索引序列化+写盘合并成 1 次。
    // v6.4.8 起 Forge/ComfyUI 也归档, 写盘频率涨了 — 每张图都 stringify 一万条索引会卡。
    // 800ms 静默期后落盘; 进程崩溃最多丢最后 <1 秒的索引更新(图文件本体不受影响,
    // 下次 updateItem/archive 会重建对应条目状态)。
    var _saveTimer = null;
    var _saveVersion = 0;
    function _cancelDebouncedSave() {
        _saveVersion++;
        if (_saveTimer) {
            clearTimeout(_saveTimer);
            _saveTimer = null;
        }
    }

    function _saveIndexDebounced() {
        var version = ++_saveVersion;
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function() {
            _saveTimer = null;
            _enqueueMutation(function() {
                return _saveIndex({ fromDebounce: true, version: version });
            }).catch(function(e) {
                if (logToPanel) logToPanel('[回收站] 延迟写入失败: ' + ((e && e.message) || e), 'warn');
            });
        }, 800);
    }

    // ========== 写: archive ==========
    // meta: 任务元数据 (workflow / prompt / context 等)
    // base64: 图像 base64 (失败任务传 null)
    // status: 'success' / 'failed' / 'aborted' / 'late'
    // errMsg: 失败原因 (可选)
    async function archiveTask(meta, base64, status, errMsg) {
        try {
            var idx = await _loadIndex();
            var folder = await _getBinFolder();
            var taskId = (meta && meta.id) || ('task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));

            var item = {
                id: taskId,
                batchId: meta.batchId || taskId,    // 任务分组 id (同一次生成的多张图共用), 老数据没有就退化成自己
                createdAt: Date.now(),
                status: status || 'success',
                workflow: meta.workflow || 'unknown',
                prompt: (meta.prompt || '').slice(0, MAX_PROMPT_CHARS),
                model: meta.model || '',
                provider: meta.provider || '',
                size: meta.size || '',
                aspectRatio: meta.aspectRatio || '',
                context: meta.context || null,
                error: errMsg || null,
                imagePath: null,
                thumbPath: null,
                extras: meta.extras || null,
                // 统一时间线(v6.4.8): 预设名/种类 + Forge 参数快照, 供[载入提示词]还原; 老数据无此字段走降级
                presetTitle: meta.presetTitle || '',
                presetKind: meta.presetKind || '',
                forgeSnapshot: meta.forgeSnapshot || null,
                // 提示词保护(半合成等): true = 前端[载入提示词]按钮禁用
                promptProtected: !!meta.promptProtected
            };

            // 写图 (只在有 base64 时)
            if (base64 && typeof base64 === 'string') {
                try {
                    var pngName = taskId + '.png';
                    var pngBuf = base64ToArrayBuffer(base64);
                    var pngFile = await folder.createFile(pngName, { overwrite: true });
                    await pngFile.write(pngBuf, { format: storage.formats.binary });
                    item.imagePath = pngName;

                    // 缩略图: 解 png 得到 RGB pixels 太复杂, 简化方案 —
                    // 直接复用原图当 thumb (UXP 没原生图像缩放). 列表加载时浏览器自己缩放.
                    // 如果未来要加真正的缩略图, 用 photoshop API 创建 thumbnail.
                    // v6.4.9: 不再用原图冒充缩略图; thumbPath 由前端压缩回传后 saveThumb 设置
                } catch(imgErr) {
                    if (logToPanel) logToPanel('[回收站] 图保存失败 ' + taskId + ': ' + imgErr.message, 'warn');
                }
            }

            // 插到索引头部 (按时间倒序); 高频路径走防抖写盘(批量归档合并成一次)
            idx.unshift(item);
            _index = idx;
            _saveIndexDebounced();
            return item;
        } catch(e) {
            if (logToPanel) logToPanel('[回收站] 归档失败: ' + e.message, 'warn');
            return null;
        }
    }

    // ========== 读: 列表 ==========
    async function listItems(opts) {
        opts = opts || {};
        var idx = await _loadIndex();
        var filtered = idx.slice();

        if (opts.filterStatus) {
            filtered = filtered.filter(function(i) { return i.status === opts.filterStatus; });
        }
        if (opts.filterWorkflow) {
            filtered = filtered.filter(function(i) { return i.workflow === opts.filterWorkflow; });
        }
        if (opts.searchPrompt) {
            var q = opts.searchPrompt.toLowerCase();
            filtered = filtered.filter(function(i) { return (i.prompt || '').toLowerCase().indexOf(q) >= 0; });
        }

        var total = filtered.length;
        var offset = +opts.offset || 0;
        var limit = +opts.limit || 50;
        return {
            total: total,
            items: filtered.slice(offset, offset + limit),
            offset: offset,
            limit: limit
        };
    }

    // ========== 读: 单张图 base64 ==========
    async function getImageBase64(taskId) {
        var idx = await _loadIndex();
        var item = idx.find(function(i) { return i.id === taskId; });
        if (!item || !item.imagePath) return null;
        try {
            var folder = await _getBinFolder();
            var f = await folder.getEntry(item.imagePath);
            var buf = await f.read({ format: storage.formats.binary });
            return arrayBufferToBase64(buf);
        } catch(_) {
            return null;
        }
    }

    // ========== 读: 缩略图 base64 (v6.4.9) ==========
    // 有真缩略图(<taskId>_thumb.jpg, 前端归档后压缩回传)就给小图;
    // 没有(老数据/压缩还没回来)退回原图 — 兼容但慢, 前端拿到后会补压一张。
    // 返回 { base64, isThumb } 或 null
    async function getThumbBase64(taskId) {
        var idx = await _loadIndex();
        var item = idx.find(function(i) { return i.id === taskId; });
        if (!item || !item.imagePath) return null;
        var folder = await _getBinFolder();
        // thumbPath 独立存在(≠imagePath)才算真缩略图
        if (item.thumbPath && item.thumbPath !== item.imagePath) {
            try {
                var tf = await folder.getEntry(item.thumbPath);
                var tbuf = await tf.read({ format: storage.formats.binary });
                return { base64: arrayBufferToBase64(tbuf), isThumb: true };
            } catch(_) { /* thumb 文件丢了, 退回原图 */ }
        }
        try {
            var f = await folder.getEntry(item.imagePath);
            var buf = await f.read({ format: storage.formats.binary });
            return { base64: arrayBufferToBase64(buf), isThumb: false };
        } catch(_) {
            return null;
        }
    }

    // ========== 写: 存前端压缩好的缩略图 (v6.4.9) ==========
    async function saveThumb(taskId, jpegBase64) {
        if (!taskId || !jpegBase64) return false;
        var idx = await _loadIndex();
        var item = idx.find(function(i) { return i.id === taskId; });
        if (!item) return false;
        try {
            var folder = await _getBinFolder();
            var thumbName = taskId + '_thumb.jpg';
            var tf = await folder.createFile(thumbName, { overwrite: true });
            await tf.write(base64ToArrayBuffer(jpegBase64), { format: storage.formats.binary });
            item.thumbPath = thumbName;
            _saveIndexDebounced();
            return true;
        } catch(e) {
            if (logToPanel) logToPanel('[回收站] 缩略图保存失败 ' + taskId + ': ' + e.message, 'warn');
            return false;
        }
    }

    // ========== 删: 单条 ==========
    async function deleteItem(taskId) {
        var idx = await _loadIndex();
        var pos = idx.findIndex(function(i) { return i.id === taskId; });
        if (pos < 0) return false;
        var item = idx[pos];
        // 删图文件
        try {
            var folder = await _getBinFolder();
            if (item.imagePath) {
                try { var f = await folder.getEntry(item.imagePath); await f.delete(); } catch(_) {}
            }
            if (item.thumbPath && item.thumbPath !== item.imagePath) {
                try { var t = await folder.getEntry(item.thumbPath); await t.delete(); } catch(_) {}
            }
        } catch(_) {}
        // 从索引剔除
        idx.splice(pos, 1);
        _index = idx;
        await _saveIndex();
        return true;
    }

    // ========== 清: 批量 ==========
    async function clearItems(opts) {
        opts = opts || {};
        var idx = await _loadIndex();
        var toKeep = [];
        var toDelete = [];
        var now = Date.now();
        idx.forEach(function(i) {
            var del = false;
            if (opts.all) del = true;
            else if (opts.olderThanDays && (now - i.createdAt) > opts.olderThanDays * 86400000) del = true;
            else if (opts.failedOnly && (i.status === 'failed' || i.status === 'aborted')) del = true;

            if (del) toDelete.push(i);
            else toKeep.push(i);
        });

        // 删图文件 (best effort, 失败也继续)
        try {
            var folder = await _getBinFolder();
            for (var i = 0; i < toDelete.length; i++) {
                var item = toDelete[i];
                if (item.imagePath) {
                    try { var f = await folder.getEntry(item.imagePath); await f.delete(); } catch(_) {}
                }
                if (item.thumbPath && item.thumbPath !== item.imagePath) {
                    try { var t = await folder.getEntry(item.thumbPath); await t.delete(); } catch(_) {}
                }
            }
        } catch(_) {}

        _index = toKeep;
        await _saveIndex();
        return { deleted: toDelete.length, remaining: toKeep.length };
    }

    // ========== 统计 ==========
    async function getStats() {
        var idx = await _loadIndex();
        var totalSize = 0;
        var byStatus = { success: 0, failed: 0, aborted: 0, late: 0 };
        idx.forEach(function(i) {
            if (byStatus[i.status] !== undefined) byStatus[i.status]++;
        });
        return {
            count: idx.length,
            byStatus: byStatus
        };
    }

    // ========== 拿元数据 (用于贴回) ==========
    async function getMeta(taskId) {
        var idx = await _loadIndex();
        return idx.find(function(i) { return i.id === taskId; }) || null;
    }

    // ========== 批量预占 N 条 pending 占位 (任务启动时调) ==========
    // metas: [{id, batchId, workflow, prompt, model, provider, size, aspectRatio, context, extras}, ...]
    // 内部强制 status='pending' / imagePath=null, 之后由 updateItem 把对应条目转最终状态
    async function beginBatchPending(metas) {
        if (!Array.isArray(metas) || metas.length === 0) return 0;
        var idx = await _loadIndex();
        var now = Date.now();
        for (var i = 0; i < metas.length; i++) {
            var m = metas[i];
            idx.unshift({
                id: m.id,
                batchId: m.batchId || m.id,
                createdAt: now,
                status: 'pending',
                workflow: m.workflow || 'unknown',
                prompt: (m.prompt || '').slice(0, MAX_PROMPT_CHARS),
                model: m.model || '',
                provider: m.provider || '',
                size: m.size || '',
                aspectRatio: m.aspectRatio || '',
                context: m.context || null,
                error: null,
                imagePath: null,
                thumbPath: null,
                extras: m.extras || null,
                presetTitle: m.presetTitle || '',
                presetKind: m.presetKind || '',
                forgeSnapshot: m.forgeSnapshot || null,
                promptProtected: !!m.promptProtected
            });
        }
        _index = idx;
        await _saveIndex();
        return metas.length;
    }

    // ========== 按 id 更新一条 pending → 最终状态 (写图 + 状态) ==========
    // 返回 null 表示没找到该 id (调用方 fallback 到 archiveTask 走 insert)
    async function updateItem(itemId, status, base64, errMsg) {
        if (!itemId) return null;
        var idx = await _loadIndex();
        var item = idx.find(function(i) { return i.id === itemId; });
        if (!item) return null;
        item.status = status || 'success';
        if (errMsg) item.error = errMsg;
        if (base64 && typeof base64 === 'string') {
            try {
                var folder = await _getBinFolder();
                var pngName = item.id + '.png';
                var pngBuf = base64ToArrayBuffer(base64);
                var pngFile = await folder.createFile(pngName, { overwrite: true });
                await pngFile.write(pngBuf, { format: storage.formats.binary });
                item.imagePath = pngName;
                // v6.4.9: 不再用原图冒充缩略图; thumbPath 由前端压缩回传后 saveThumb 设置
            } catch(imgErr) {
                if (logToPanel) logToPanel('[回收站] 更新图失败 ' + itemId + ': ' + imgErr.message, 'warn');
            }
        }
        _saveIndexDebounced();   // 高频路径(批量生成每张回图都调): 防抖合并写盘
        return item;
    }

    // ========== 启动时清理孤儿 pending → aborted (PS 重启时未跑完的兜底) ==========
    async function cleanupOrphanPending() {
        var idx = await _loadIndex();
        var n = 0;
        for (var i = 0; i < idx.length; i++) {
            if (idx[i].status === 'pending') {
                idx[i].status = 'aborted';
                idx[i].error = 'PS 重启时任务未完成';
                n++;
            }
        }
        if (n > 0) await _saveIndex();
        return n;
    }

    return {
        archiveTask: _serializeMutation(archiveTask),
        beginBatchPending: _serializeMutation(beginBatchPending),
        updateItem: _serializeMutation(updateItem),
        cleanupOrphanPending: _serializeMutation(cleanupOrphanPending),
        listItems: listItems,
        getImageBase64: getImageBase64,
        getThumbBase64: getThumbBase64,
        saveThumb: _serializeMutation(saveThumb),
        getMeta: getMeta,
        deleteItem: _serializeMutation(deleteItem),
        clearItems: _serializeMutation(clearItems),
        getStats: getStats
    };
}

module.exports = { createRecycleBinModule: createRecycleBinModule };
