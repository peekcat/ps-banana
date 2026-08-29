// ============================================================
//  tile-aistatus.host.js — 服务器状态磁贴 host 端
//  ★ 开源, 用户可读 ★
//
//  做的事:
//    1. aistatusFetch:        前端发起查询大盘, host 这边代理 fetch
//    2. aistatusOpenCodeFile: 用本地编辑器打开主插件源码文件 (透明审计)
//
//  上报逻辑本身不在这里, 在 host/ai-api.js 里 (那边知道每次调用结果)
// ============================================================

var HostAPI = require('../host/host-api.js');
var serverConfig = require('../core/server-config.js');

HostAPI.registerAction('aistatusFetch', async function(data, ctx) {
    try {
        // 前端可传 window=1h/24h/7d, 默认 1h (跟历史行为一致)
        var win = (data && data.window) || '1h';
        if (['1h', '24h', '7d'].indexOf(win) < 0) win = '1h';
        var resp = await serverConfig.fetchApi('/api/aistatus?window=' + encodeURIComponent(win));
        var body = null;
        try { body = await resp.json(); } catch (_) {}
        ctx.sendToPanel('aistatusResult', {
            success: resp.ok,
            status: resp.status,
            data: body,
            window: win,
            error: resp.ok ? null : ('HTTP ' + resp.status)
        });
    } catch (e) {
        ctx.sendToPanel('aistatusResult', {
            success: false,
            error: e.message || String(e)
        });
    }
}, { tileId: 'aistatus' });

// 用本地编辑器打开主插件源码 (用户审计代码用)
HostAPI.registerAction('aistatusOpenCodeFile', async function(data, ctx) {
    try {
        var rel = data && data.rel;
        if (!rel || rel.indexOf('..') !== -1) return;   // 防路径穿越
        var uxpFs = require('uxp').storage.localFileSystem;
        var pluginFolder = await uxpFs.getPluginFolder();
        var path = pluginFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\') + '\\' + rel.replace(/\//g, '\\');
        var shell = require('uxp').shell;
        if (shell && shell.openPath) {
            await shell.openPath(path);
        }
    } catch (e) {
        ctx.logToPanel('[服务器状态] 打开代码文件失败: ' + e.message, 'warn');
    }
}, { tileId: 'aistatus' });

module.exports = {};
