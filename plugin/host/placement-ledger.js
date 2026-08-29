// ============================================================
//  placement-ledger.js —— 回传台账
//  记录「贴回 PS 的图层 ↔ image_cache 缓存」的对应关系,
//  Dock 校色按钮靠它反查某个图层对应的原图(input)/回图(output)。
//
//  两份存储:
//  - 内存(最近 500 条): 当场查询
//  - runFolder/meta.json: 插件重载/PS 重启后兜底反查
//    (PS 重启后 docId 会变 → meta.json 匹配时用 docName 辅助)
//
//  谁在登记: 第一期只有 tile-run.host.js 主生成贴回循环。
//  后续路径(批处理/分区/海报...)接入 = 贴回后同样调 record + writeMetaJson。
//
//  entry 字段:
//    docId, docName, layerId, runFolderName, inputIdx, outputIdx,
//    selection(贴回位置), antiMode, layerType, featherKey, engine, ts
//
//  缓存重构(两级结构)后: runFolderName 既可能是老平铺的一段名
//  ("20260731_153042_api_..."), 也可能是两级路径("婚纱_6f0a/修脸_0731_...")。
//  读文件夹一律走 getRunFolderByPath(按 / 分段行走), 两种都认。
// ============================================================

var _uxp = require('uxp');
var _lfs = _uxp.storage.localFileSystem;

var MAX_MEM_ENTRIES = 500;
var META_SCAN_LIMIT = 60;   // meta.json 兜底最多翻最近多少个缓存文件夹(平铺+叶子合计)

var _entries = [];   // 新条目 push 到末尾, 查询从末尾往前(新的优先)

// "a/b" 或 "a" → 从 image_cache 根按段走到目标文件夹; 找不到抛错
async function getRunFolderByPath(cacheFolder, runPath) {
    var segs = String(runPath || '').split('/');
    var cur = cacheFolder;
    for (var i = 0; i < segs.length; i++) {
        if (!segs[i]) continue;
        cur = await cur.getEntry(segs[i]);
    }
    if (cur === cacheFolder) throw new Error('缓存路径为空');
    return cur;
}

function record(entry) {
    if (!entry || entry.layerId == null || !entry.runFolderName) return;
    _entries.push(entry);
    if (_entries.length > MAX_MEM_ENTRIES) _entries.splice(0, _entries.length - MAX_MEM_ENTRIES);
}

function _memFind(docId, layerId) {
    for (var i = _entries.length - 1; i >= 0; i--) {
        var e = _entries[i];
        if (e.layerId === layerId && e.docId === docId) return e;
    }
    return null;
}

// meta.json 兜底: 收集候选生成文件夹(老平铺一级 + 新结构两级叶子), 按时间倒序翻最近 N 个
async function _metaScan(docId, docName, layerId) {
    var cacheFolder;
    try {
        var dataFolder = await _lfs.getDataFolder();
        cacheFolder = await dataFolder.getEntry('image_cache');
    } catch (e) { return null; }

    var entries;
    try { entries = await cacheFolder.getEntries(); } catch (e2) { return null; }

    // 候选 = {path: 相对 image_cache 的路径, sortKey: 排序用}
    // 老平铺文件夹名以日期开头(2026...), 新项目文件夹里是叶子(预设名_月日_时分秒_xx)
    var candidates = [];
    for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isFolder) continue;
        if (/^\d{8}_/.test(entries[i].name)) {
            // 老平铺: 文件夹名自带完整日期时间, 直接可排序
            candidates.push({ path: entries[i].name, sortKey: entries[i].name });
        } else {
            // 新结构项目文件夹: 下一层叶子才是生成文件夹
            var leaves;
            try { leaves = await entries[i].getEntries(); } catch (e3) { continue; }
            for (var j = 0; j < leaves.length; j++) {
                if (!leaves[j].isFolder) continue;
                // 叶子名尾部是 _月日_时分秒_xx → 抽出来当排序键(没匹配到就排最旧)
                var m = leaves[j].name.match(/_(\d{4})_(\d{6})_[a-z0-9]+$/);
                var key = m ? ('9' + m[1] + m[2]) : '0';   // '9'前缀让新结构在同刻时排老平铺(2...)前面
                candidates.push({ path: entries[i].name + '/' + leaves[j].name, folder: leaves[j], sortKey: key });
            }
        }
    }
    candidates.sort(function(a, b) { return a.sortKey < b.sortKey ? 1 : -1; });   // 新的在前

    var limit = Math.min(candidates.length, META_SCAN_LIMIT);
    for (var f = 0; f < limit; f++) {
        var runFolder = candidates[f].folder;
        try {
            if (!runFolder) runFolder = await getRunFolderByPath(cacheFolder, candidates[f].path);
        } catch (eWalk) { continue; }
        var metaFile;
        try { metaFile = await runFolder.getEntry('meta.json'); } catch (eNo) { continue; }
        try {
            var parsed = JSON.parse(await metaFile.read());
            var list = (parsed && parsed.entries) || [];
            for (var k = 0; k < list.length; k++) {
                var e = list[k];
                if (e.layerId !== layerId) continue;
                // docId 相同(同一 PS 会话) 或 docName 相同(PS 重启后 docId 变了) 都算命中
                if (e.docId === docId || (docName && e.docName === docName)) {
                    e.runFolderName = candidates[f].path;
                    return e;
                }
            }
        } catch (eParse) { continue; }
    }
    return null;
}

// 主查询: 先内存, 再 meta.json 兜底
async function findByLayer(docId, docName, layerId) {
    var hit = _memFind(docId, layerId);
    if (hit) return hit;
    return await _metaScan(docId, docName, layerId);
}

// 把本次贴回的台账条目写进 runFolder/meta.json(与已有条目合并)
async function writeMetaJson(runFolder, newEntries) {
    if (!runFolder || !newEntries || !newEntries.length) return;
    var existing = [];
    try {
        var old = await runFolder.getEntry('meta.json');
        var parsed = JSON.parse(await old.read());
        if (parsed && Array.isArray(parsed.entries)) existing = parsed.entries;
    } catch (e) { /* 没有旧 meta.json, 正常 */ }
    var file = await runFolder.createFile('meta.json', { overwrite: true });
    await file.write(JSON.stringify({ entries: existing.concat(newEntries) }));
}

// 排障用: 账本现状(条数 + 最近几条的 docId/layerId)
function debugStats() {
    var tail = [];
    for (var i = Math.max(0, _entries.length - 5); i < _entries.length; i++) {
        tail.push('doc' + _entries[i].docId + '/层' + _entries[i].layerId);
    }
    return { count: _entries.length, tail: tail };
}

module.exports = {
    record: record,
    findByLayer: findByLayer,
    writeMetaJson: writeMetaJson,
    getRunFolderByPath: getRunFolderByPath,
    debugStats: debugStats
};
