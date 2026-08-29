// ============================================================
//  tile-sync.host.js
//  预设同步服务(独立服务器,和云 Forge 不同源)
//  只拉不推 — 无需认证
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');

// ============================================================
//  syncFetchList — 获取服务器预设文件名列表
//  返回 { success, files:[...], error? }
// ============================================================
HostAPI.registerAction('syncFetchList', async function(data, ctx) {
    try {
        var resp = await serverConfig.fetchApi('/api/presets', { method: 'GET' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var json = await resp.json();
        var files = (json && json.files) || [];
        ctx.sendToPanel('syncFetchListResult', { success: true, files: files });
    } catch(e) {
        ctx.sendToPanel('syncFetchListResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'sync' });

// ============================================================
//  syncFetchManifest — 拉清单 (file + hash + title + size + category)
//  支持老服务端: 检测到 manifest 404 时退回 /api/presets, items 标 _legacy
//  返回 { success, items:[...], legacy?, error? }
// ============================================================
HostAPI.registerAction('syncFetchManifest', async function(data, ctx) {
    try {
        var resp = await serverConfig.fetchApi('/api/presets/manifest', { method: 'GET' });
        if (resp.status === 404) {
            // 老服务端没 manifest 接口, 退回到 /api/presets, hash 留空 → 每个文件都视作要下载
            var listResp = await serverConfig.fetchApi('/api/presets', { method: 'GET' });
            if (!listResp.ok) throw new Error('HTTP ' + listResp.status);
            var listJson = await listResp.json();
            var legacyItems = ((listJson && listJson.files) || []).map(function(f) {
                return { file: f, title: '', hash: '', size: 0, category: '' };
            });
            ctx.sendToPanel('syncFetchManifestResult', { success: true, items: legacyItems, legacy: true });
            return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var json = await resp.json();
        ctx.sendToPanel('syncFetchManifestResult', { success: true, items: (json && json.items) || [], legacy: false });
    } catch(e) {
        ctx.sendToPanel('syncFetchManifestResult', { success: false, error: e.message || String(e) });
    }
}, { tileId: 'sync' });

// ============================================================
//  syncFetchOne — 获取单个预设内容
//  data: { file: "xxx.json" }
//  返回 { success, file, preset?, error? }
// ============================================================
HostAPI.registerAction('syncFetchOne', async function(data, ctx) {
    var file = data && data.file;
    if (!file) {
        ctx.sendToPanel('syncFetchOneResult', { success: false, file: '', error: '缺少文件名' });
        return;
    }
    try {
        var resp = await serverConfig.fetchApi('/api/presets/' + encodeURIComponent(file), { method: 'GET' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var preset = await resp.json();
        if (preset && typeof preset === 'object') {
            preset._cloudFile = file;  // 打印标记,方便前端记录来源
        }
        ctx.sendToPanel('syncFetchOneResult', { success: true, file: file, preset: preset });
    } catch(e) {
        ctx.sendToPanel('syncFetchOneResult', { success: false, file: file, error: e.message || String(e) });
    }
}, { tileId: 'sync' });

module.exports = {};
