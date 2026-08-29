async function handleMiscAction(action, data, ctx) {
    async function fetchJsonWithTimeout(url, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function() { try { controller.abort(); } catch (_) {} }, timeoutMs || 8000);
        try {
            var response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return await response.json();
        } finally {
            clearTimeout(timer);
        }
    }

    switch (action) {
        // exportPreset / importPreset / loadPresetsFile / savePresetsFile 已迁移到 tiles/tile-presets.host.js
        // forge preset cases migrated to tiles/tile-forge.host.js

        // case 'calibrateBalance' 已迁移到 tiles/tile-tasks.host.js

        case 'captureForChat':
            if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
            await ctx.acquirePSLock(function() { return ctx.handleCaptureForChat(); }, 'capture-for-chat');
            return true;

        case 'openActionsPanel':
            var actionsReqId = data && data.reqId;
            try {
                var ps = require('photoshop');
                if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
                await ctx.acquirePSLock(function() {
                    return ps.core.executeAsModal(function() {
                        return ps.app.batchPlay([{
                            _obj: 'select',
                            _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'toggleActionsPalette' }]
                        }], {});
                    }, { commandName: '打开 Photoshop 动作面板' });
                }, 'open-actions-panel:' + (actionsReqId || Date.now()));
                ctx.sendToPanel('openActionsPanelResult', { reqId: actionsReqId, success: true });
            } catch (panelErr) {
                ctx.logToPanel('[动作] 无法打开 Photoshop 动作面板: ' + ((panelErr && panelErr.message) || panelErr), 'error');
                ctx.sendToPanel('openActionsPanelResult', { reqId: actionsReqId, success: false, error: (panelErr && panelErr.message) || String(panelErr) });
            }
            return true;

        case 'chatSettingsUpdated':
            if (data && data.chatMaxResolution) {
                ctx.hostStorageRef.value['chat_max_resolution'] = data.chatMaxResolution;
                ctx.debounceSave();
                ctx.logToPanel('[聊天] 图片分辨率已更新: ' + data.chatMaxResolution, 'info');
            }
            return true;

        case 'openUrl':
            try {
                var _url = (data && data.url) || '';
                // 安全闸: 只允许 http(s), 防止恶意/被改的公告下发 file:/// 或本地路径
                // 兜底 shell.openPath 是真能打开本地任意文件/目录的, 必须挡在前面
                if (!/^https?:\/\//i.test(_url)) {
                    ctx.logToPanel('[警告] 拒绝打开非 http(s) 链接: ' + _url, 'warn');
                    return true;
                }
                ctx.logToPanel('[链接] 正在打开: ' + _url, 'info');
                var uxpKeys = Object.keys(ctx.uxpModule).join(', ');
                console.log('[openUrl] uxpModule keys:', uxpKeys);
                var opened = false;
                if (ctx.uxpModule.shell && typeof ctx.uxpModule.shell.openExternal === 'function') {
                    console.log('[openUrl] 使用 uxpModule.shell.openExternal');
                    await ctx.uxpModule.shell.openExternal(_url);
                    opened = true;
                }
                if (!opened && ctx.uxpModule.host && typeof ctx.uxpModule.host.openExternal === 'function') {
                    console.log('[openUrl] 使用 uxpModule.host.openExternal');
                    await ctx.uxpModule.host.openExternal(_url);
                    opened = true;
                }
                if (!opened && ctx.uxpModule.shell && typeof ctx.uxpModule.shell.openPath === 'function') {
                    console.log('[openUrl] 使用 uxpModule.shell.openPath');
                    await ctx.uxpModule.shell.openPath(_url);
                    opened = true;
                }
                if (!opened) {
                    ctx.logToPanel('[提示] UXP可用属性: ' + uxpKeys, 'warn');
                    ctx.logToPanel('[提示] 请手动访问: ' + _url, 'warn');
                }
            } catch (e) {
                ctx.logToPanel('[错误] 无法打开链接: ' + (e.message || e), 'error');
            }
            return true;

        case 'fetchPublicIp':
            try {
                // 优先用 ipify(国外稳定),失败尝试国内备用
                var ip = '';
                try {
                    var j = await fetchJsonWithTimeout('https://api.ipify.org?format=json', 8000);
                    ip = j.ip || '';
                } catch(e1) { /* fallthrough */ }
                if (!ip) {
                    try {
                        var j2 = await fetchJsonWithTimeout('https://ipinfo.io/json', 8000);
                        ip = j2.ip || '';
                    } catch(e2) {}
                }
                if (ip) {
                    // 模糊末位: 1.2.3.4 -> 1.2.3.*  |  IPv6 类似处理
                    var masked = ip.indexOf(':') >= 0
                        ? ip.replace(/:[0-9a-fA-F]+$/, ':****')
                        : ip.replace(/\.\d+$/, '.*');
                    ctx.sendToPanel('publicIpResult', { success: true, ip: masked, raw: ip });
                } else {
                    ctx.sendToPanel('publicIpResult', { success: false, error: '无法获取公网 IP' });
                }
            } catch(e) {
                ctx.sendToPanel('publicIpResult', { success: false, error: e.message });
            }
            return true;

        // case 'youdaoTranslate' 已迁移到 tiles/tile-translate.host.js
        // case 'cloud*' 已迁移到 tiles/tile-cloud.host.js
    }
    return false;
}

module.exports = {
    handleMiscAction: handleMiscAction
};
