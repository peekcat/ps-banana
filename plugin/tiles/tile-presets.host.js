// ============================================================
//  tile-presets.host.js
//  预设管理后端处理器（主预设系统）
//  通过 HostAPI.registerAction 注册到路由表
//
//  从 index.js 迁移而来的 handler：
//    handleLoadPresetsFile / handleSavePresetsFile
//    handleOpenPresetFolder / handleRefreshPresets
//    exportPreset / importPreset
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

// === 常量 ===
var PRESETS_SUBFOLDER = "presets";
var FACTORY_PRESETS_SUBFOLDER = "factory_presets";
// 兼容旧版文件名（用于迁移）
var OLD_USER_PRESETS_FILE    = "user_presets.json";
var OLD_HIDDEN_PRESETS_FILE  = "hidden_presets.json";

// 保存预设: 直接写主文件 + 一份 .bak 兜底。
// 【为什么不再用 .writing+rename 原子写】UXP 的 entry.rename 在本环境频繁失败
//   (尤其目标已存在时——rename 不带 overwrite 会抛错), 导致文件永远卡在 .writing、主文件丢失。
//   官方文档: createFile(name, {overwrite:true}) 支持覆盖写, 比 rename 可靠得多。
//   所以改为: ① 先写 .bak 冷备份(写崩了它还在) ② 再 overwrite 写主文件。
//   主文件即便写到一半崩, 加载时可从 .bak 恢复(见 loadPresetsFile 自愈段)。
async function _atomicWritePreset(folder, fileName, content) {
    var bakName = fileName + '.bak';
    // 1. 先写一份冷备份(主文件写崩时的救命稻草)
    try {
        var bak = await folder.createFile(bakName, { overwrite: true });
        await bak.write(content);
    } catch (_) { /* 备份失败不致命, 继续写主文件 */ }
    // 2. 直接覆盖写主文件(不依赖 rename)
    var main = await folder.createFile(fileName, { overwrite: true });
    await main.write(content);
    // 3. 主文件写成功了, 删掉这次的 .bak(下次保存会重写; 平时不留一堆 .bak)
    try { var done = await folder.getEntry(bakName); await done.delete(); } catch (_) {}
}

// ============================================================
//  loadPresetsFile — 加载预设列表
// ============================================================
HostAPI.registerAction('loadPresetsFile', async function(data, ctx) {
    var dataFolder = await fs.getDataFolder();
    var pluginFolder = await fs.getPluginFolder();
    var presetsFolder;
    var isNewFolder = false;

    // 1. 获取或创建 dataFolder/presets/
    try {
        presetsFolder = await dataFolder.getEntry(PRESETS_SUBFOLDER);
    } catch(e) {
        try {
            presetsFolder = await dataFolder.createFolder(PRESETS_SUBFOLDER);
        } catch(e2) {
            ctx.logToPanel("[预设] 获取/创建预设文件夹失败,本次跳过(避免空列表覆盖前端): " + e2.message, "error");
            // 不发 presetsFileLoaded — 让前端保留它已有的内存数据,而不是被空数组覆盖
            return;
        }
        isNewFolder = true;
    }

    // 2. 首次运行：从 pluginFolder/factory_presets/ 复制所有预设
    if (isNewFolder) {
        try {
            var factoryFolder = await pluginFolder.getEntry(FACTORY_PRESETS_SUBFOLDER);
            var factoryEntries = await factoryFolder.getEntries();
            var copyCount = 0;
            for (var fi = 0; fi < factoryEntries.length; fi++) {
                var fe = factoryEntries[fi];
                if (fe.isFile && fe.name.endsWith('.json')) {
                    try {
                        var content = await fe.read();
                        await _atomicWritePreset(presetsFolder, fe.name, content);
                        copyCount++;
                    } catch(ce) { console.warn("[预设] 复制失败: " + fe.name, ce); }
                }
            }
            ctx.logToPanel("[预设] 首次运行，已复制 " + copyCount + " 个工厂预设", "info");
        } catch(e) {
            ctx.logToPanel("[预设] 工厂预设目录不存在: " + e.message, "warn");
        }

        // 3. 兼容旧版迁移：user_presets.json → 单文件
        try {
            var oldUserFile = await dataFolder.getEntry(OLD_USER_PRESETS_FILE);
            var oldUserText = await oldUserFile.read();
            var oldUserPresets = JSON.parse(oldUserText);
            if (Array.isArray(oldUserPresets) && oldUserPresets.length > 0) {
                var migratedCount = 0;
                for (var ui = 0; ui < oldUserPresets.length; ui++) {
                    var up = oldUserPresets[ui];
                    if (!up.title) continue;
                    up._isFactory = false;
                    if (!up.id) up.id = 'u_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                    delete up.hidden;
                    var userFileName = ctx.sanitizeFileName(up.title) + '.json';
                    userFileName = await ctx.getUniqueFileName(presetsFolder, userFileName);
                    await _atomicWritePreset(presetsFolder, userFileName, JSON.stringify(up, null, 2));
                    migratedCount++;
                }
                ctx.logToPanel("[预设] 从旧版迁移了 " + migratedCount + " 个用户预设", "info");
            }
            try { await oldUserFile.delete(); } catch(de) {}
        } catch(e) { /* 旧文件不存在，正常 */ }

        // 4. 兼容旧版迁移：hidden_presets.json → 删除对应文件
        try {
            var oldHiddenFile = await dataFolder.getEntry(OLD_HIDDEN_PRESETS_FILE);
            var oldHiddenText = await oldHiddenFile.read();
            var hiddenIds = JSON.parse(oldHiddenText);
            if (Array.isArray(hiddenIds) && hiddenIds.length > 0) {
                var entries = await presetsFolder.getEntries();
                var deletedCount = 0;
                for (var ei = 0; ei < entries.length; ei++) {
                    if (!entries[ei].isFile || !entries[ei].name.endsWith('.json')) continue;
                    try {
                        var txt = await entries[ei].read();
                        var parsed = JSON.parse(txt);
                        if (parsed.id && hiddenIds.indexOf(parsed.id) !== -1) {
                            await entries[ei].delete();
                            deletedCount++;
                        }
                    } catch(pe) {}
                }
                if (deletedCount > 0) ctx.logToPanel("[预设] 已移除 " + deletedCount + " 个旧版隐藏预设", "info");
            }
            try { await oldHiddenFile.delete(); } catch(de) {}
        } catch(e) { /* 旧文件不存在，正常 */ }

    } else {
        // 非首次运行：不自动补充工厂预设（用户可能故意删除了某些预设）
        // 如需恢复工厂预设，用户可删除整个 presets 文件夹后重启插件
    }

    // 5.5 自愈: 把历史上卡住的预设救回来(不依赖 rename, rename 在本环境不可靠)。
    //   - 孤儿 <name>.json.writing(旧版原子写卡住, 同名 .json 不存在) → 读内容重写成 .json
    //   - 孤儿 <name>.json.bak(主文件写崩, 同名 .json 不存在或为空) → 读内容重写成 .json
    //   - 若主 .json 已正常存在 → 删掉残留的 .writing / .bak
    //   恢复用"读→createFile(overwrite)重写→删源", 不用 rename。
    try {
        var healEntries = await presetsFolder.getEntries();
        var healMap = {};
        for (var hi = 0; hi < healEntries.length; hi++) { if (healEntries[hi].isFile) healMap[healEntries[hi].name] = healEntries[hi]; }
        var healed = 0;
        async function _mainOk(jsonName) {
            var e = healMap[jsonName]; if (!e) return false;
            try { var t = await e.read(); return !!(t && t.trim().length > 1); } catch (_) { return false; }
        }
        async function _reviveFrom(srcEntry, jsonName) {
            try {
                var txt = await srcEntry.read();
                if (!txt || !txt.trim()) return false;
                var nf = await presetsFolder.createFile(jsonName, { overwrite: true });
                await nf.write(txt);
                return true;
            } catch (_) { return false; }
        }
        for (var hn in healMap) {
            if (!healMap.hasOwnProperty(hn)) continue;
            var m = /^(.*\.json)\.(writing|bak|old)$/i.exec(hn);
            if (!m) continue;
            var jsonName = m[1];
            if (await _mainOk(jsonName)) {
                // 主文件正常 → 删残留
                try { await healMap[hn].delete(); } catch (_) {}
            } else {
                // 主文件缺失/损坏 → 从残留恢复
                if (await _reviveFrom(healMap[hn], jsonName)) { healed++; try { await healMap[hn].delete(); } catch (_) {} }
            }
        }
        if (healed > 0) ctx.logToPanel("[预设] 自愈恢复了 " + healed + " 个上次没存完的预设", "warn");
    } catch (e) {
        console.warn("[预设] 自愈扫描失败(不致命): " + (e && e.message));
    }

    // 6. 扫描 dataFolder/presets/ 中所有 .json 文件
    var allPresets = [];
    try {
        var allEntries = await presetsFolder.getEntries();
        for (var ai = 0; ai < allEntries.length; ai++) {
            var ae = allEntries[ai];
            if (!ae.isFile || !ae.name.endsWith('.json')) continue;
            try {
                var presetText = await ae.read();
                var preset = JSON.parse(presetText);
                preset._fileName = ae.name; // 内部字段：文件名，用于后续保存/删除
                if (!preset.id) preset.id = 'p_' + ae.name.replace(/\.json$/, '');
                allPresets.push(preset);
            } catch(pe) {
                console.warn("[预设] 解析失败，跳过: " + ae.name, pe.message);
            }
        }
    } catch(e) {
        ctx.logToPanel("[预设] 扫描预设文件夹失败: " + e.message, "error");
    }

    // 7. 排序：用户预设在前，工厂预设在后（工厂预设按文件名排序）
    allPresets.sort(function(a, b) {
        var aFactory = !!a._isFactory;
        var bFactory = !!b._isFactory;
        if (!aFactory && bFactory) return -1;
        if (aFactory && !bFactory) return 1;
        return (a._fileName || '').localeCompare(b._fileName || '');
    });

    var factoryCount = allPresets.filter(function(p) { return p._isFactory; }).length;
    var userCount = allPresets.length - factoryCount;

    // 8. 发送给面板
    ctx.sendToPanel('presetsFileLoaded', { presets: allPresets, factoryCount: factoryCount, userCount: userCount });
    ctx.logToPanel("[预设] 已加载 " + allPresets.length + " 个预设 (工厂:" + factoryCount + " 用户:" + userCount + ")", "info");
}, { tileId: 'presets' });

// ============================================================
//  savePresetsFile — 保存/删除/导入预设
// ============================================================
HostAPI.registerAction('savePresetsFile', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var presetsFolder = await ctx.getOrCreatePresetsFolder(dataFolder);

        if (data.action === 'save') {
            // === 保存单个预设 ===
            var preset = data.preset;
            if (!preset) return;

            var fileName;
            if (preset._fileName) {
                // 已有文件名（编辑已有预设）
                fileName = preset._fileName;
            } else {
                // 新预设：从标题生成文件名
                fileName = ctx.sanitizeFileName(preset.title || 'preset') + '.json';
                fileName = await ctx.getUniqueFileName(presetsFolder, fileName);
            }

            // 写入文件（去掉内部字段）
            var clone = JSON.parse(JSON.stringify(preset));
            delete clone._fileName;
            delete clone.hidden;
            delete clone._overriddenByUser;

            await _atomicWritePreset(presetsFolder, fileName, JSON.stringify(clone, null, 2));
            ctx.logToPanel("[预设] 已保存: " + (preset.title || fileName), "success");

            // 重新扫描并发送更新列表
            await HostAPI.dispatchAction('loadPresetsFile', {}, ctx);

        } else if (data.action === 'delete') {
            // === 删除预设文件 ===
            var delPreset = data.preset;
            if (delPreset && delPreset._fileName) {
                try {
                    var delFile = await presetsFolder.getEntry(delPreset._fileName);
                    await delFile.delete();
                    ctx.logToPanel("[预设] 已删除: " + (delPreset.title || delPreset._fileName), "success");
                } catch(de) {
                    ctx.logToPanel("[预设] 删除失败: " + de.message, "error");
                }
            } else {
                ctx.logToPanel("[预设] 删除失败: 未找到文件名", "error");
            }
            await HostAPI.dispatchAction('loadPresetsFile', {}, ctx);

        } else if (data.action === 'import') {
            // === 批量导入预设（同名或同ID覆盖） ===
            // 兼容字段:历史上前端发的字段名混乱,有 preset / presets 两种,这里都接受
            var importPresets = Array.isArray(data.presets) ? data.presets
                              : Array.isArray(data.preset) ? data.preset
                              : null;
            if (!importPresets) {
                ctx.logToPanel("[预设] 导入失败:未提供有效的预设数组(应为 data.presets)", "error");
                return;
            }

            // 扫描已有预设，建立 id→fileName 和 title→fileName 映射
            var existingById = {};
            var existingByTitle = {};
            try {
                var existEntries = await presetsFolder.getEntries();
                for (var ei = 0; ei < existEntries.length; ei++) {
                    var ee = existEntries[ei];
                    if (!ee.isFile || !ee.name.endsWith('.json')) continue;
                    try {
                        var eTxt = await ee.read();
                        var eParsed = JSON.parse(eTxt);
                        if (eParsed.id) existingById[eParsed.id] = ee.name;
                        if (eParsed.title) existingByTitle[eParsed.title] = ee.name;
                    } catch(_pe) {}
                }
            } catch(_se) {}

            var importCount = 0;
            var overwriteCount = 0;
            for (var ii = 0; ii < importPresets.length; ii++) {
                var ip = importPresets[ii];
                if (!ip.title) continue;
                var ipClone = JSON.parse(JSON.stringify(ip));
                delete ipClone._fileName;
                delete ipClone.hidden;
                delete ipClone._overriddenByUser;
                if (!ipClone._isFactory) ipClone._isFactory = false;
                if (!ipClone.id) ipClone.id = 'u_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

                // 查找已有同ID或同名预设的文件名
                var matchedFileName = null;
                if (ipClone.id && existingById[ipClone.id]) {
                    matchedFileName = existingById[ipClone.id];
                } else if (ip.title && existingByTitle[ip.title]) {
                    matchedFileName = existingByTitle[ip.title];
                }

                var ipFileName;
                if (matchedFileName) {
                    ipFileName = matchedFileName;
                    overwriteCount++;
                } else {
                    ipFileName = ctx.sanitizeFileName(ip.title) + '.json';
                    ipFileName = await ctx.getUniqueFileName(presetsFolder, ipFileName);
                }

                await _atomicWritePreset(presetsFolder, ipFileName, JSON.stringify(ipClone, null, 2));
                // 更新映射表，防止本批次后续同名/同ID预设生成重复文件
                if (ipClone.id) existingById[ipClone.id] = ipFileName;
                if (ipClone.title) existingByTitle[ipClone.title] = ipFileName;
                importCount++;
            }
            ctx.logToPanel("[预设] 已导入 " + importCount + " 个预设" + (overwriteCount > 0 ? "（其中覆盖 " + overwriteCount + " 个同名/同ID预设）" : ""), "success");
            await HostAPI.dispatchAction('loadPresetsFile', {}, ctx);

        } else if (data.presets) {
            // === 兼容旧格式：{ presets: [...] } → 忽略（新系统不再使用全量保存）===
            ctx.logToPanel("[预设] 收到旧格式保存请求，已忽略（新系统使用单文件模式）", "warn");
        }
    } catch(e) {
        ctx.logToPanel("[预设] 保存操作失败: " + e.message, "error");
        console.error("[预设] 保存操作失败:", e);
    }
}, { tileId: 'presets' });

// ============================================================
//  openPresetFolder — 打开预设文件夹
// ============================================================
HostAPI.registerAction('openPresetFolder', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var presetsFolder = await ctx.getOrCreatePresetsFolder(dataFolder);
        var folderPath = presetsFolder.nativePath;
        ctx.sendToPanel('presetFolderPath', { path: folderPath });
        await ctx.openFolderWithMultipleMethods(folderPath, '[预设]');
    } catch(e) {
        ctx.logToPanel("[预设] 打开文件夹失败: " + e.message, "error");
    }
}, { tileId: 'presets' });

// ============================================================
//  refreshPresets — 刷新预设列表
// ============================================================
HostAPI.registerAction('refreshPresets', async function(data, ctx) {
    ctx.logToPanel("[预设] 正在刷新预设列表...", "info");
    await HostAPI.dispatchAction('loadPresetsFile', {}, ctx);
}, { tileId: 'presets' });

// ============================================================
//  exportPreset — 导出预设到文件
// ============================================================
HostAPI.registerAction('exportPreset', async function(data, ctx) {
    try {
        // 兼容三种前端调用形态:
        //   { preset: object | array }  ← 当前 tile-presets / tile-bodypreset 用的字段
        //   { data: '<JSON 字符串>' }    ← 旧约定,保留兼容
        //   { presets: [...] }           ← 备用别名
        var payload = data && (data.data !== undefined ? data.data : (data.preset !== undefined ? data.preset : data.presets));
        if (payload === undefined || payload === null) {
            ctx.logToPanel('导出失败: 没有可导出的内容', 'error');
            return;
        }
        var jsonText = (typeof payload === 'string') ? payload : JSON.stringify(payload, null, 2);
        var defaultName = data.fileName || 'presets.json';
        var file = await fs.getFileForSaving(defaultName, { types: ['json'] });
        if (!file) return;
        await file.write(jsonText);
        ctx.logToPanel('预设已导出到文件', 'success');
    } catch (err) { ctx.logToPanel('导出失败: ' + err.message, 'error'); }
}, { tileId: 'presets' });

// ============================================================
//  importPreset — 从文件导入预设
// ============================================================
HostAPI.registerAction('importPreset', async function(data, ctx) {
    try {
        var files = await fs.getFileForOpening({ types: ["json"], allowMultiple: true });
        if (!files) return;
        // 兼容单文件返回（非数组）
        if (!Array.isArray(files)) files = [files];
        for (var i = 0; i < files.length; i++) {
            var text = await files[i].read();
            // 字段名 data + text 都发,前端任一处理
            ctx.sendToPanel('importPresetData', { text: text, data: text });
        }
        if (files.length > 1) ctx.logToPanel("已导入 " + files.length + " 个预设文件", "success");
    } catch (err) { ctx.logToPanel("导入失败: " + err.message, "error"); }
}, { tileId: 'presets' });

module.exports = {};
