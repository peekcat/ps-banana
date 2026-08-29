// ============================================================
//  host-api.js
//  后端插件注册中心。磁贴的 *.host.js 文件通过此处的 registerAction
//  注册自己需要的后端消息处理器。
//
//  用法（在 tile-foo.host.js 里）：
//      const HostAPI = require('../host/host-api.js');
//      HostAPI.registerAction('fooDoSomething', async function(data, ctx) {
//          // data: 前端 sendToHost 时传的载荷
//          // ctx: 和现有 handler 一致的 host 上下文（sendToPanel、uxpModule、g_xxx 等）
//          ctx.sendToPanel('fooResult', { ok: true });
//      }, { tileId: 'foo' });
// ============================================================

var _actions = {};   // action name → handler(data, ctx)
var _meta = {};      // action name → { tileId, registeredAt }

function registerAction(name, handler, opts) {
    if (typeof name !== 'string' || !name) {
        console.error('[HostAPI] registerAction: 非法的 action 名');
        return;
    }
    if (typeof handler !== 'function') {
        console.error('[HostAPI] registerAction: ' + name + ' 的 handler 不是函数');
        return;
    }
    if (_actions[name]) {
        console.warn('[HostAPI] 覆盖已注册的 action: ' + name +
            '（原属 ' + (_meta[name] && _meta[name].tileId) + '）');
    }
    _actions[name] = handler;
    _meta[name] = {
        tileId: (opts && opts.tileId) || null,
        registeredAt: Date.now()
    };
}

function hasAction(name) {
    return !!_actions[name];
}

async function dispatchAction(action, data, ctx) {
    var handler = _actions[action];
    if (!handler) return false;
    try {
        await handler(data || {}, ctx);
    } catch (e) {
        var errMsg = (e && e.message) || String(e);
        console.error('[HostAPI] ' + action + ' 执行失败:', errMsg);
        if (ctx && typeof ctx.logToPanel === 'function') {
            ctx.logToPanel('后端处理 ' + action + ' 失败: ' + errMsg, 'error');
        }
    }
    return true;   // 视为已处理（即使抛错也不要回退到 legacy 链）
}

function listActions() {
    return Object.keys(_actions).slice();
}

function getActionMeta(name) {
    return _meta[name] || null;
}

module.exports = {
    registerAction: registerAction,
    hasAction: hasAction,
    dispatchAction: dispatchAction,
    listActions: listActions,
    getActionMeta: getActionMeta
};
