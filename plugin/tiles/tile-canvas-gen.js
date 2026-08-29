// ============================================================
//  tile-canvas-gen.js
//  接受独立插件(轮椅幕布)委托生成 -- 面板侧桥接
//
//  零侵入: 由 scanTiles 自动加载, 不注册磁贴(无 UI),
//  只做桥接: host 轮询到请求 -> 这里拿 key -> 调 canvasGenerate -> 回写
//
//  消息流:
//    1. 加载时 sendToHost('cvGenBootstrap') 让 host 启动自轮询
//    2. host 轮询到请求后 sendToPanel('cvGenResolveAndRun', {...})
//    3. 本文件拿 key, 调 sendToHost('canvasGenerate', {...})
//    4. tile-canvas.host.js 完成后广播 'canvasGenerateResult'
//    5. 本文件匹配 reqId, 回调 sendToHost('cvGenWriteResult', {...})
//    6. 成功后触发计费(GRS proxy refill + generate:complete 流水)
// ============================================================
(function() {
'use strict';

// 等待中的委托请求: _pending[internalReqId] = { ipcReqId, provider, model, size }
var _pending = {};
var _seqId = 0;

// ---- 收到 host 转来的 IPC 请求 ----
TileAPI.onHostMessage('cvGenResolveAndRun', function(msg) {
    if (!msg || !msg.reqId) return;

    var ipcReqId = msg.reqId;
    var provider = msg.provider || '';

    // 拿 API key
    var conn = null;
    try {
        if (typeof window._settingsGetActiveConnection === 'function') {
            conn = window._settingsGetActiveConnection(provider || undefined);
        }
    } catch (e) {
        conn = null;
    }

    if (!conn || !conn.key) {
        // 检查是否是 GRS key 还在加载中
        if (conn && conn._grsKeyPending) {
            TileAPI.sendToHost('cvGenWriteResult', {
                reqId: ipcReqId,
                success: false,
                error: '算力密钥正在加载中, 请稍后重试'
            });
        } else if (conn && conn._grsNeedLogin) {
            TileAPI.sendToHost('cvGenWriteResult', {
                reqId: ipcReqId,
                success: false,
                error: '夏算力托管需要登录 (主面板顶栏账号区), 或切回「自带 Key」'
            });
        } else {
            TileAPI.sendToHost('cvGenWriteResult', {
                reqId: ipcReqId,
                success: false,
                error: '没有可用的 API 密钥 (provider: ' + (provider || '未指定') + ')'
            });
        }
        return;
    }

    // 生成内部 reqId 以区分来自 canvasGenerateResult 广播中的不同请求
    _seqId++;
    var internalReqId = 'cvg_delegate_' + Date.now() + '_' + _seqId;

    _pending[internalReqId] = {
        ipcReqId: ipcReqId,
        provider: conn.provider || provider,
        model: msg.model || '',
        size: msg.size || ''
    };

    // 调用现有的 canvasGenerate action (tile-canvas.host.js)
    TileAPI.sendToHost('canvasGenerate', {
        reqId: internalReqId,
        apiKey: conn.key,
        apiBaseUrl: conn.url || '',
        provider: conn.provider || provider,
        prompt: msg.prompt || '',
        images: msg.images || [],
        model: msg.model || '',
        size: msg.size || '',
        aspectRatio: msg.aspectRatio || '',
        timeout: msg.timeout || 3600
    });
});

// ---- 收到 canvasGenerateResult 广播(所有磁贴都会收到) ----
// 用 TileAPI.onHostMessage 精确监听, 只处理我们发出的 reqId
TileAPI.onHostMessage('canvasGenerateResult', function(msg) {
    if (!msg || !msg.reqId) return;
    var info = _pending[msg.reqId];
    if (!info) return;    // 不是我们发的请求, 忽略
    delete _pending[msg.reqId];

    var ipcReqId = info.ipcReqId;

    if (msg.success && msg.base64) {
        // ---- 计费 (try/catch 守卫, 失败不影响结果回传) ----
        try {
            info.docName = msg.docName || '';
            info.docPath = msg.docPath || '';
            _doBilling(info, 1, 0);
        } catch (e) {
            try { console.warn('[cvGen] 计费异常(不影响结果): ' + ((e && e.message) || e)); } catch (_) {}
        }
        // 回写结果给 host(host 再写文件)
        TileAPI.sendToHost('cvGenWriteResult', {
            reqId: ipcReqId,
            success: true,
            base64: msg.base64
        });
    } else {
        // AJI 按已发送请求计费；GRS/墨墨会在统一流水层忽略失败数。
        try {
            info.docName = msg.docName || '';
            info.docPath = msg.docPath || '';
            _doBilling(info, 0, msg.requestAttempted === false ? 0 : 1);
        } catch (e2) {
            try { console.warn('[cvGen] 失败请求计费异常: ' + ((e2 && e2.message) || e2)); } catch (_) {}
        }
        TileAPI.sendToHost('cvGenWriteResult', {
            reqId: ipcReqId,
            success: false,
            error: msg.error || '生成失败'
        });
    }
});

// ---- 计费: 复刻 tile-tasks.js taskComplete 的逻辑 ----
function _doBilling(info, successCount, failCount) {
    var provider = info.provider || '';
    var model = info.model || '';
    var size = info.size || '';
    successCount = Math.max(0, Number(successCount) || 0);
    failCount = Math.max(0, Number(failCount) || 0);

    // 1. 本地流水: emit generate:complete (tile-billing.js 监听并记账)
    //    只对 aji/grs/others 记本地流水(和 tile-billing.js _recordLedger 一致)
    try {
        TileAPI.emit('generate:complete', {
            taskId: 'cvg_delegate',
            success: successCount,
            generatedSuccess: successCount,
            fail: failCount,
            provider: provider,
            model: model,
            size: size,
            engine: 'canvas',      // 标记来源
            docName: info.docName || '',
            docPath: info.docPath || ''
        });
    } catch (_) {}

    // 2. GRS 算力续杯: 仅 provider=grs + 走 proxy(非 BYOK)路径时 ping
    try {
        if (provider === 'grs' && successCount > 0 && TileAPI.compute && TileAPI.compute.getState) {
            var byokActive = false;
            if (typeof TileAPI.compute.isUserByokActive === 'function') {
                byokActive = TileAPI.compute.isUserByokActive();
            } else {
                byokActive = !!(TileAPI.storage.get('connection.grs.key'));
            }
            var cs = TileAPI.compute.getState();
            if (!byokActive && cs && cs.key) {
                var usedTotal = 1800 * successCount;
                if (typeof TileAPI.compute.estimateCost === 'function') {
                    usedTotal = TileAPI.compute.estimateCost(model, successCount) || usedTotal;
                }
                TileAPI.compute.refill(usedTotal, successCount);
            }
        }
    } catch (_) {}
}

// ---- host 就绪回执(调试) ----
TileAPI.onHostMessage('cvGenReady', function() {
    try { if (TileAPI.log) TileAPI.log('[cvGen] host 自轮询已就绪', 'info'); } catch (_) {}
});

// ---- 启动 host 自轮询 ----
function _bootstrap() {
    try { TileAPI.sendToHost('cvGenBootstrap', {}); } catch (_) {}
}
_bootstrap();
try { TileAPI.on('app:ready', _bootstrap); } catch (_) {}

})();
