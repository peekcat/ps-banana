// ============================================================
//  tile-cloud.host.js
//  云服务后端处理器：登录/注册/积分/充值/云Forge/公告
//  通过 HostAPI.registerAction 注册到路由表
// ============================================================

var HostAPI = require('../host/host-api.js');
var cloudService = require('../login-service.js');

// === 模块内 helper ===

function resolveForgeTargetSize(params, savedSelection) {
    var targetLong = parseInt(params && params.resolution, 10);
    if (!(targetLong > 0)) {
        var fw = parseInt(params && params.width, 10) || 0;
        var fh = parseInt(params && params.height, 10) || 0;
        targetLong = Math.max(fw, fh);
    }
    if (!(targetLong > 0)) targetLong = 768;

    if (savedSelection && savedSelection.width > 0 && savedSelection.height > 0) {
        var w = Math.max(1, Math.round(savedSelection.width));
        var h = Math.max(1, Math.round(savedSelection.height));
        var longEdge = Math.max(w, h);
        var scale = targetLong / longEdge;
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        return { width: w, height: h };
    }

    var fallbackW = parseInt(params && params.width, 10);
    var fallbackH = parseInt(params && params.height, 10);
    if (!(fallbackW > 0)) fallbackW = targetLong;
    if (!(fallbackH > 0)) fallbackH = targetLong;
    return { width: fallbackW, height: fallbackH };
}

// ============================================================
//  1. cloudLogin
// ============================================================
HostAPI.registerAction('cloudLogin', async function(data, ctx) {
    console.log("[宿主-云登录] cloudLogin 收到请求, email=" + (data.email || "(空)"));
    ctx.logToPanel("[云服务] 正在登录 " + data.email + "...", "info");
    try {
        var res = await cloudService.performLogin(data.email, data.password, data.remember, data.rememberPassword);
        console.log("[宿主-云登录] performLogin 返回:", JSON.stringify(res).substring(0, 300));
        ctx.sendToPanel('cloudLoginResult', res);
        if (res.success) ctx.logToPanel("[云服务] 登录成功: " + data.email, "success");
        else ctx.logToPanel("[云服务] 登录失败: " + (res.message || ""), "error");
    } catch(e) {
        console.error("[宿主-云登录] 异常!", e.name, e.message);
        ctx.logToPanel("[云服务] 登录异常: " + e.name + ": " + e.message, "error");
        ctx.sendToPanel('cloudLoginResult', { success: false, message: e.name + ": " + e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  2. cloudRegister
// ============================================================
HostAPI.registerAction('cloudRegister', async function(data, ctx) {
    try {
        var res = await cloudService.apiRegister(data.email, data.password, data.captcha, data.uuid);
        ctx.sendToPanel('cloudRegisterResult', { success: res.errno === 0, message: res.info || "", data: res });
        if (res.errno === 0) ctx.logToPanel("[云服务] 注册成功", "success");
        else ctx.logToPanel("[云服务] 注册失败: " + (res.info || ""), "error");
    } catch(e) {
        ctx.sendToPanel('cloudRegisterResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  3. cloudLogout
// ============================================================
HostAPI.registerAction('cloudLogout', async function(data, ctx) {
    try {
        var rememberedSetting = null;
        try {
            rememberedSetting = cloudService.getCloudSetting();
        } catch(e2) {}
        await cloudService.performLogout(data.email);
        ctx.sendToPanel('cloudLogoutResult', { success: true, setting: rememberedSetting });
        ctx.logToPanel("[云服务] 已登出", "info");
    } catch(e) {
        ctx.sendToPanel('cloudLogoutResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  4. cloudGetCaptcha
// ============================================================
HostAPI.registerAction('cloudGetCaptcha', async function(data, ctx) {
    try {
        var res = await cloudService.apiGetCaptcha();
        // 新后台返回 { errno:0, id, svg }; 归一化成面板要的 { uuid, img(data URI) }
        var svg = (res && res.svg) || '';
        var img = svg ? ('data:image/svg+xml;utf8,' + encodeURIComponent(svg)) : '';
        ctx.sendToPanel('cloudCaptchaResult', {
            success: !!(res && res.errno === 0),
            data: { uuid: (res && res.id) || '', img: img }
        });
    } catch(e) {
        ctx.sendToPanel('cloudCaptchaResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  5. cloudRestoreSession
// ============================================================
HostAPI.registerAction('cloudRestoreSession', async function(data, ctx) {
    console.log("[宿主-云] cloudRestoreSession 开始");
    try {
        var res = await cloudService.tryRestoreSession();
        console.log("[宿主-云] tryRestoreSession 返回:", JSON.stringify(res).substring(0, 300));
        ctx.sendToPanel('cloudRestoreResult', res);
        if (res.success) ctx.logToPanel("[云服务] 已恢复登录会话: " + ((res.user && res.user.email) || ""), "info");
        else console.log("[宿主-云] 恢复会话失败(无本地数据)");
    } catch(e) {
        console.error("[宿主-云] restoreSession异常:", e.name, e.message);
        ctx.sendToPanel('cloudRestoreResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  6. cloudGetAnnouncement
// ============================================================
HostAPI.registerAction('cloudGetAnnouncement', async function(data, ctx) {
    console.log("[宿主-云] cloudGetAnnouncement 开始");
    ctx.logToPanel("[云服务] 正在获取公告...", "info");
    try {
        var res = await cloudService.apiGetAnnouncement();
        console.log("[宿主-云] apiGetAnnouncement 返回:", JSON.stringify(res).substring(0, 300));
        var content = "";
        if (res && res.data && res.data.content) content = res.data.content;
        else if (res && res.content) content = res.content;
        else if (res && res.info) content = res.info;
        var links = (res && Array.isArray(res.links)) ? res.links : ((res && res.data && Array.isArray(res.data.links)) ? res.data.links : []);
        ctx.sendToPanel('cloudAnnouncementResult', { success: true, content: content, links: links, data: res });
        if (content) ctx.logToPanel("[云服务] 公告已获取", "success");
        else ctx.logToPanel("[云服务] 公告内容为空", "warn");
    } catch(e) {
        console.error("[宿主-云] getAnnouncement异常:", e.name, e.message);
        ctx.logToPanel("[云服务] 获取公告失败: " + e.name + ": " + e.message, "error");
        ctx.sendToPanel('cloudAnnouncementResult', { success: false, message: e.name + ": " + e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  7. cloudGetUserPoints
// ============================================================
HostAPI.registerAction('cloudGetUserPoints', async function(data, ctx) {
    console.log("[宿主-云] cloudGetUserPoints 开始");
    ctx.logToPanel("[云服务] 正在获取积分...", "info");
    try {
        var res = await cloudService.apiGetUserPoints();
        console.log("[宿主-云] apiGetUserPoints 返回:", JSON.stringify(res).substring(0, 500));
        // 新后台返回 { errno:0, common_points, banana_points }; 云Forge 用通用池 common_points
        var isSuccess = !!(res && res.errno === 0);
        var points = (res && typeof res.common_points === 'number') ? res.common_points : 0;
        var banana = (res && typeof res.banana_points === 'number') ? res.banana_points : 0;
        ctx.sendToPanel('cloudPointsResult', { success: isSuccess, points: points, banana: banana, data: res });
        ctx.logToPanel("[云服务] 积分: " + points, isSuccess ? "success" : "warn");
    } catch(e) {
        console.error("[宿主-云] getUserPoints异常:", e.name, e.message);
        ctx.logToPanel("[云服务] 获取积分异常: " + e.message, "error");
        ctx.sendToPanel('cloudPointsResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  8. cloudRechargeCardKey
// ============================================================
HostAPI.registerAction('cloudRechargeCardKey', async function(data, ctx) {
    try {
        var res = await cloudService.apiRechargeByCardKey(data.cardKey);
        ctx.sendToPanel('cloudRechargeResult', { success: res.errno === 0, message: res.info || "", data: res });
        if (res.errno === 0) ctx.logToPanel("[云服务] 充值成功!", "success");
        else ctx.logToPanel("[云服务] 充值失败: " + (res.info || ""), "error");
        // 充值成功且是 banana 池 → 顺手刷一下 compute key (服务端那边异步建/续杯, 这里拉新状态)
        if (res.errno === 0 && res.pool === 'banana') {
            // 留 1.5s 让服务端的 setImmediate 跑完
            setTimeout(function() {
                cloudService.performComputeKeyRefresh().then(function(norm) {
                    ctx.sendToPanel('cloudComputeKeyResult', norm);
                }).catch(function() {});
            }, 1500);
        }
    } catch(e) {
        ctx.sendToPanel('cloudRechargeResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  8.5  GRS 算力 (Stage 4): get / refill / sync / byok
// ============================================================
HostAPI.registerAction('cloudComputeGetKey', async function(data, ctx) {
    try {
        // forceRefresh=true 时强刷, 否则优先返回本地缓存 (省一次网络)
        var norm;
        if (data && data.forceRefresh) {
            norm = await cloudService.performComputeKeyRefresh();
        } else {
            var cached = await cloudService.getCachedComputeState();
            if (cached && cached.key) {
                norm = { success: true, mode: cached.mode, key: cached.key, key_status: cached.key_status,
                         cap: cached.cap, balance: cached.balance, last_sync_at: cached.last_sync_at,
                         expires_at: cached.expires_at, fromCache: true };
                // 后台异步校准, 不阻塞回应
                cloudService.performComputeKeyRefresh().then(function(fresh) {
                    if (fresh && fresh.success) ctx.sendToPanel('cloudComputeKeyResult', fresh);
                }).catch(function() {});
            } else {
                norm = await cloudService.performComputeKeyRefresh();
            }
        }
        ctx.sendToPanel('cloudComputeKeyResult', norm);
    } catch(e) {
        ctx.sendToPanel('cloudComputeKeyResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

HostAPI.registerAction('cloudComputeRefill', async function(data, ctx) {
    try {
        var res = await cloudService.apiComputeRefill(data && data.used, data && data.attempts);
        var ok = res && res.errno === 0;
        ctx.sendToPanel('cloudComputeRefillResult', {
            success: ok,
            refilled: !!(res && res.refilled),
            before: res && res.before,
            after: res && res.after,
            remaining: res && res.remaining,
            reason: res && res.reason,
            // Stage 7 风控反馈
            daily_used: res && res.daily_used,
            hour_used: res && res.hour_used,
            paused: !!(res && res.paused),
            throttled: !!(res && res.throttled),
            throttled_until: res && res.throttled_until,
            errno: res && res.errno,
            code: res && res.code,
            info: res && res.info,
            error: res && res.error,
            raw: res
        });
        if (ok) {
            // 不管服务端这次有没有"续杯"动作, 都把本地缓存的 cap/balance 校准一遍.
            // 服务端在 refill 里已经实际扣分, 不刷新本地就跟服务端脱节, 余额磁贴永远不变.
            cloudService.performComputeKeyRefresh().catch(function() {});
        }
    } catch(e) {
        ctx.sendToPanel('cloudComputeRefillResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

HostAPI.registerAction('cloudComputeSync', async function(data, ctx) {
    try {
        var res = await cloudService.apiComputeSync();
        // sync 完了刷一下本地缓存
        await cloudService.performComputeKeyRefresh();
        ctx.sendToPanel('cloudComputeSyncResult', { success: !!(res && res.errno === 0), remaining: res && res.remaining, raw: res });
    } catch(e) {
        ctx.sendToPanel('cloudComputeSyncResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

HostAPI.registerAction('cloudComputeSetByok', async function(data, ctx) {
    try {
        var mode = (data && data.mode === 'byok') ? 'byok' : 'proxy';
        var res = await cloudService.apiComputeSetByok(mode);
        var ok = res && res.errno === 0;
        if (ok) await cloudService.performComputeKeyRefresh();
        ctx.sendToPanel('cloudComputeByokResult', { success: ok, mode: res && res.mode, info: res && res.info });
        ctx.logToPanel(ok ? ("[云服务] 算力模式切换 → " + mode) : ("[云服务] 算力模式切换失败"), ok ? "info" : "error");
    } catch(e) {
        ctx.sendToPanel('cloudComputeByokResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  9. cloudGetForgeUrl
// ============================================================
HostAPI.registerAction('cloudGetForgeUrl', async function(data, ctx) {
    console.log("[宿主-云] cloudGetForgeUrl 开始");
    ctx.logToPanel("[云服务] 正在获取云Forge URL...", "info");
    try {
        var res = await cloudService.apiGetExposedPublicUrl();
        console.log("[宿主-云] apiGetExposedPublicUrl 返回:", JSON.stringify(res).substring(0, 300));
        ctx.logToPanel("[云服务-Forge] 获取URL结果: success=" + res.success, res.success ? "success" : "warn");
        ctx.sendToPanel('cloudForgeUrlResult', res);
    } catch(e) {
        console.error("[宿主-云] getForgeUrl异常:", e.name, e.message);
        ctx.logToPanel("[云服务] 获取云Forge URL异常: " + e.message, "error");
        ctx.sendToPanel('cloudForgeUrlResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  10. cloudTestForgeConnection
// ============================================================
HostAPI.registerAction('cloudTestForgeConnection', async function(data, ctx) {
    try {
        var res = await cloudService.testCloudForgeConnection(data.encrypted);
        ctx.sendToPanel('cloudForgeTestResult', res);
        // On success, auto-fetch models/samplers via Forge tile's actions
        if (res.success && data.encrypted) {
            var cloudUrl = cloudService.decryptUrl(data.encrypted);
            if (cloudUrl) {
                cloudUrl = cloudUrl.replace(/\/$/, '');
                ctx.logToPanel("[云Forge] 自动拉取模型列表...", "info");
                HostAPI.dispatchAction('forgeFetchModels', { url: cloudUrl }, ctx);
                HostAPI.dispatchAction('forgeFetchSamplers', { url: cloudUrl }, ctx);
                HostAPI.dispatchAction('forgeFetchLoras', { url: cloudUrl }, ctx);
                HostAPI.dispatchAction('forgeFetchControlNetModules', { url: cloudUrl }, ctx);
                HostAPI.dispatchAction('forgeFetchControlNetModels', { url: cloudUrl }, ctx);
            }
        }
    } catch(e) {
        ctx.sendToPanel('cloudForgeTestResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  10b. cloudForgeProbe — 诊断专用:只测试连接 + 拿模型数,不触发副作用
// ============================================================
HostAPI.registerAction('cloudForgeProbe', async function(data, ctx) {
    if (!data || !data.encrypted) {
        ctx.sendToPanel('cloudForgeProbeResult', { success: false, error: '未登录云服务或未获取 URL' });
        return;
    }
    try {
        var res = await cloudService.testCloudForgeConnection(data.encrypted);
        // 原接口返回 {success, encrypted, modelCount} 或 {success:false, error}
        ctx.sendToPanel('cloudForgeProbeResult', res);
    } catch(e) {
        ctx.sendToPanel('cloudForgeProbeResult', { success: false, error: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  11. cloudForgeImg2Img
// ============================================================
HostAPI.registerAction('cloudForgeImg2Img', async function(data, ctx) {
    // 前置失败(解密/扣分)也要结算前端任务卡片, 否则卡片永久残留在任务清单
    var _cfTaskId = (data && data.taskId) || null;
    function _cloudForgeFail(errMsg) {
        ctx.sendToPanel('forgeComplete', { taskId: _cfTaskId, success: false, error: errMsg });
        if (_cfTaskId) ctx.sendToPanel('taskComplete', { taskId: _cfTaskId, successCount: 0, failCount: 1, engine: 'forge', error: errMsg });
    }
    var url = cloudService.decryptUrl(data.encrypted);
    if (!url) {
        _cloudForgeFail("无效的云服务URL");
        return;
    }
    data.url = url.replace(/\/$/, '');
    delete data.encrypted;

    // === 先扣积分（先收费再干活）===
    var modelName = data.model || 'unknown';
    var consumeSize = resolveForgeTargetSize(data, null);
    var resMax = Math.max(consumeSize.width, consumeSize.height);
    var genCount = parseInt(data.batchSize, 10) || 1;
    var genSteps = parseInt(data.steps, 10) || 20;
    try {
        ctx.logToPanel("[云Forge] 正在扣除积分...", "info");
        var consumeRes = await cloudService.apiConsumePoints({
            service: 'forge', model: modelName, resolution: resMax, count: genCount, steps: genSteps
        });
        console.log("[云Forge] consume 返回:", JSON.stringify(consumeRes).substring(0, 300));
        // 新后台 /auth/consume 返回 { errno:0, consumed, pool, balance }; 失败(含 errno:4 积分不足)带 info
        if (consumeRes && consumeRes.errno === 0) {
            var consumed = consumeRes.consumed || 0;
            var newBalance = (typeof consumeRes.balance === 'number') ? consumeRes.balance : 0;
            ctx.logToPanel("[云Forge] 已扣积分 " + consumed + "，剩余：" + newBalance, "success");
            ctx.sendToPanel('cloudConsumePointsResult', { success: true, consumed: consumed, newBalance: newBalance, data: consumeRes });
        } else {
            var errMsg = (consumeRes && consumeRes.info) || '积分扣除失败';
            ctx.logToPanel("[云Forge] " + errMsg, "error");
            _cloudForgeFail(errMsg);
            return;  // 扣分没成功 → 直接停, 绝不生成 (0 积分在此被 errno:4 拦死)
        }
    } catch(e) {
        ctx.logToPanel("[云Forge] 积分扣除异常: " + e.message, "error");
        _cloudForgeFail("积分扣除异常: " + e.message);
        return;
    }

    // === 执行生成（积分已扣） ===
    await HostAPI.dispatchAction('forgeImg2Img', data, ctx);
}, { tileId: 'cloud' });

// ============================================================
//  12. cloudConsumePoints
// ============================================================
HostAPI.registerAction('cloudConsumePoints', async function(data, ctx) {
    try {
        var res = await cloudService.apiConsumePoints(data);
        ctx.sendToPanel('cloudConsumePointsResult', { success: res.errno === 0, data: res });
    } catch(e) {
        ctx.sendToPanel('cloudConsumePointsResult', { success: false, message: e.message });
    }
}, { tileId: 'cloud' });

// ============================================================
//  13. cloudResetPasswordByCard — 找回密码 (匿名, 用卡密自助核验)
// ============================================================
HostAPI.registerAction('cloudResetPasswordByCard', async function(data, ctx) {
    var email = (data && data.email) ? String(data.email).trim() : '';
    var cardKey = (data && data.cardKey) ? String(data.cardKey).trim() : '';
    var newPw = (data && data.newPassword) ? String(data.newPassword) : '';
    console.log("[宿主-云] cloudResetPasswordByCard email=" + email + " card=" + (cardKey ? cardKey.substring(0,4)+'****' : '(空)'));
    try {
        var res = await cloudService.apiResetPasswordByCard(email, cardKey, newPw);
        var ok = !!(res && res.errno === 0);
        ctx.sendToPanel('cloudPasswordResetResult', {
            success: ok,
            message: (res && res.info) || (ok ? '密码已重置' : '重置失败')
        });
        ctx.logToPanel(ok ? ("[云服务] 密码已重置: " + email) : ("[云服务] 重置失败: " + ((res && res.info) || '')), ok ? 'success' : 'warn');
    } catch(e) {
        console.error("[宿主-云] cloudResetPasswordByCard 异常:", e.name, e.message);
        ctx.sendToPanel('cloudPasswordResetResult', { success: false, message: e.name + ": " + e.message });
    }
}, { tileId: 'cloud' });

module.exports = {};
