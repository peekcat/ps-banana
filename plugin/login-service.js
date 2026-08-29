// ============================================================
//  login-service.js - 云服务登录/鉴权/积分/公告模块
//  运行在 UXP 宿主环境 (index.js 引用)
//  通过 postMessage 与 WebView (panel.js) 交互
//
//  【已对接新自建后台 preset-server】
//   - 标准 REST: 该 GET 的 GET, 该 POST 的 POST
//   - 鉴权统一走 Authorization: Bearer <access_token>
//   - 丢弃老协议: tokenKey 设备签名 / app=Ps.sdui / globalAuthParams 查询串
//   - Forge/ComfyUI 的 URL 仍 XOR 加密, 只在本宿主临时解密后直连,
//     永远不把明文 URL 交给面板 (防止用户拿到地址绕过付费直连)
// ============================================================

const uxpLS = require("uxp");
const fsLS = uxpLS.storage.localFileSystem;
const serverConfig = require("./core/server-config.js");

// ===== 配置常量 =====
// 正式地址和当前后台回退地址统一由 core/server-config.js 管理。
const AUTH_HOST = serverConfig.OFFICIAL_BASE;
const LS_SETTING_FILE = "cloud_setting.json";
const LS_USER_FILE = "cloud_user.json";
const AUTH_REQUEST_TIMEOUT_MS = 20000;

// access_token 用于 Bearer 鉴权; email 仅用于本地显示
const globalAuthParams = {
    access_token: "",
    email: ""
};

// ===== 文件存储 =====
async function lsWriteFile(fileName, content) {
    try {
        var folder = await fsLS.getDataFolder();
        var file = await folder.createFile(fileName, { overwrite: true });
        await file.write(content);
    } catch (e) {
        console.warn("[云服务] 写文件失败:", fileName, e.message);
    }
}

async function lsReadFile(fileName) {
    try {
        var folder = await fsLS.getDataFolder();
        var file = await folder.getEntry(fileName);
        return await file.read();
    } catch (e) {
        return null;
    }
}

async function lsDeleteFile(fileName) {
    try {
        var folder = await fsLS.getDataFolder();
        var file = await folder.getEntry(fileName);
        await file.delete();
    } catch (e) {
        // 文件原本不存在也视为已经清理完成。
    }
}

// ===== 设置管理 =====
var _cloudSetting = {
    remember: false,
    email: "",
    offlineMode: false
};

async function loadCloudSetting() {
    try {
        var data = await lsReadFile(LS_SETTING_FILE);
        if (data) {
            var parsed = JSON.parse(data);
            // 历史遗留: 老版本会把明文 password 写进 cloud_setting.json
            // 启动时一并清掉, 避免本地文件长期残留敏感数据
            var hadPassword = parsed && Object.prototype.hasOwnProperty.call(parsed, 'password');
            if (hadPassword) delete parsed.password;
            Object.assign(_cloudSetting, parsed);
            if (hadPassword) { try { await saveCloudSetting(); } catch (_) {} }
        }
    } catch (e) {
        console.warn("[云服务] 读取 cloud_setting.json 失败:", e && e.message);
    }
}

async function saveCloudSetting() {
    await lsWriteFile(LS_SETTING_FILE, JSON.stringify(_cloudSetting));
}

function getCloudSetting() { return _cloudSetting; }

function updateCloudSetting(key, value, save) {
    _cloudSetting[key] = value;
    if (save) saveCloudSetting();
}

// ===== API 请求层 =====
function setAuthParams(params) {
    for (var k in params) globalAuthParams[k] = params[k];
}

// 统一请求: method 默认 POST. GET 时 params 拼到查询串, POST 时 params 进 JSON body.
// 登录态用 Bearer header 携带 access_token (新后台不再认 tokenKey/查询串签名)。
async function authRequest(action, params, method) {
    method = (method || "POST").toUpperCase();
    var fullUrl = AUTH_HOST + action;
    var headers = { "Accept": "application/json" };
    if (globalAuthParams.access_token) headers["Authorization"] = "Bearer " + globalAuthParams.access_token;

    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
        try { controller.abort(); } catch (_) {}
    }, AUTH_REQUEST_TIMEOUT_MS);
    var opts = { method: method, headers: headers, signal: controller.signal };
    if (method === "GET") {
        if (params && Object.keys(params).length) {
            var qs = Object.keys(params).map(function (k) {
                return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
            }).join("&");
            fullUrl += "?" + qs;
        }
    } else {
        headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(params || {});
    }

    console.log("[云服务-authRequest] " + method + " " + AUTH_HOST + action +
        (globalAuthParams.access_token ? " (Bearer)" : " (匿名)"));
    try {
        var response = await serverConfig.fetchApi(fullUrl.substring(AUTH_HOST.length), opts);
        console.log("[云服务-authRequest] 响应状态:", response.status, response.statusText);
        var text = await response.text();

        // HTTP 错误状态优先按状态码兜底, 避免把纯文本错误信息当 JSON 解析失败
        if (!response.ok) {
            if (response.status === 429) {
                return { errno: -1, info: "请求太频繁, 请稍等几秒再试", httpStatus: 429, temporary: true };
            }
            if (response.status === 401 || response.status === 403) {
                return { errno: -1, info: "登录失效或没有权限, 请重新登录", httpStatus: response.status, authInvalid: true };
            }
            if (response.status === 404) {
                return { errno: -1, info: "服务器路径不存在 (404), 后端可能没启动或地址错了, 请联系作者", httpStatus: 404, temporary: true };
            }
            if (response.status >= 500) {
                return { errno: -1, info: "服务器暂时不可用 (HTTP " + response.status + "), 请稍后再试", httpStatus: response.status, temporary: true };
            }
            // 其他 4xx: 尝试解析 JSON (后端可能返回结构化错误), 失败再兜底纯文本
            try {
                var errJson = JSON.parse(text);
                if (errJson && typeof errJson === 'object') errJson.httpStatus = response.status;
                return errJson;
            } catch (_) {
                return { errno: -1, info: "请求失败 (HTTP " + response.status + "): " + text.substring(0, 100), httpStatus: response.status };
            }
        }

        try {
            return JSON.parse(text);
        } catch (je) {
            console.error("[云服务-authRequest] JSON解析失败:", je.message, "原始:", text.substring(0, 300));
            return { errno: -1, info: "响应不是有效JSON: " + text.substring(0, 100) };
        }
    } catch (fetchErr) {
        console.error("[云服务-authRequest] fetch失败 action=" + action, fetchErr.name, fetchErr.message);
        if (fetchErr && fetchErr.name === 'AbortError') {
            var timeoutErr = new Error('连接云服务超时（20 秒），请检查网络后重试');
            timeoutErr.temporary = true;
            timeoutErr.code = 'AUTH_TIMEOUT';
            throw timeoutErr;
        }
        try { fetchErr.temporary = true; } catch (_) {}
        throw fetchErr;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ===== 简单加密/解密 URL（XOR + Base64）=====
// 用于把云服务URL在内存/面板间以密文流转，明文只在本宿主临用临解，不落地、不进面板
var _xorKey = "xsq2026banana";

function xorEncrypt(text) {
    var result = [];
    for (var i = 0; i < text.length; i++) {
        result.push(text.charCodeAt(i) ^ _xorKey.charCodeAt(i % _xorKey.length));
    }
    return btoa(String.fromCharCode.apply(null, result));
}

function xorDecrypt(encoded) {
    try {
        var decoded = atob(encoded);
        var result = [];
        for (var i = 0; i < decoded.length; i++) {
            result.push(decoded.charCodeAt(i) ^ _xorKey.charCodeAt(i % _xorKey.length));
        }
        return String.fromCharCode.apply(null, result);
    } catch (e) {
        return "";
    }
}

// ===== 业务 API =====

// 登录  POST /auth/login  body:{ user, password }
async function apiLogin(email, password) {
    return await authRequest("/auth/login", { user: email, password: password }, "POST");
}

// 注册  POST /auth/register  body:{ user, password, captcha, captchaId }
async function apiRegister(email, password, captcha, captchaId) {
    return await authRequest("/auth/register", {
        user: email, password: password, captcha: captcha, captchaId: captchaId
    }, "POST");
}

// 登出  POST /auth/logout  (Bearer)
async function apiLogout() {
    return await authRequest("/auth/logout", {}, "POST");
}

// 验证码  GET /auth/captcha  →  { errno:0, id, svg }
async function apiGetCaptcha() {
    return await authRequest("/auth/captcha", {}, "GET");
}

// 查积分  GET /auth/points  →  { errno:0, common_points, banana_points, user }
async function apiGetUserPoints() {
    return await authRequest("/auth/points", {}, "GET");
}

// 扣分  POST /auth/consume  body:{ service, model, resolution, count, steps }
//   先扣再生成: 扣成功(errno:0)才放行; 积分不足返回 errno:4, 调用方据此拦住生成
async function apiConsumePoints(params) {
    var p = Object.assign({ service: "forge" }, params || {});
    return await authRequest("/auth/consume", p, "POST");
}

// 卡密充值  POST /auth/recharge  body:{ card_key }
async function apiRechargeByCardKey(cardKey) {
    return await authRequest("/auth/recharge", { card_key: cardKey }, "POST");
}

// 找回密码 (用卡密自助核验)  POST /auth/recover-password-by-card  body:{ email, card_key, new_password }
// 匿名接口 — 临时清掉 token 头不带 Bearer; 失败信息一律模糊化
async function apiResetPasswordByCard(email, cardKey, newPassword) {
    var savedToken = globalAuthParams.access_token;
    globalAuthParams.access_token = '';
    try {
        return await authRequest("/auth/recover-password-by-card", {
            email: email, card_key: cardKey, new_password: newPassword
        }, "POST");
    } finally {
        globalAuthParams.access_token = savedToken;
    }
}

// ============================================================
//  GRS 算力 (compute) 接口  ——  Stage 4
// ============================================================
//  4 个用户端接口 (全部 Bearer):
//    GET  /compute/key       拿自己专属子 key (lazy 创建)
//    POST /compute/refill    生成完后 ping, 触发续杯 (服务端按规则决定)
//    POST /compute/sync      强制对账 (debug)
//    POST /compute/byok      body:{mode:'byok'|'proxy'} 切自带模式
//
//  本地缓存策略:
//    - GRS key 用 XOR 加密 (老规矩, 仅防止文件被偷看) 存进 cloud_user.json
//    - 字段名 grs_api_key_enc / grs_compute_mode / grs_key_status
//    - 登录时一并拉取; 离线/恢复会话时直接读本地 (能用就先用, 联网后再校准)
//    - 登出时连同清除
// ============================================================

async function apiComputeGetKey() {
    return await authRequest("/compute/key", null, "GET");
}

async function apiComputeRefill(usedCredits, attempts) {
    return await authRequest("/compute/refill", {
        used: usedCredits || 0,
        attempts: attempts || 0
    }, "POST");
}

async function apiComputeSync() {
    return await authRequest("/compute/sync", {}, "POST");
}

// mode: 'byok' 或 'proxy'
async function apiComputeSetByok(mode) {
    return await authRequest("/compute/byok", { mode: (mode === 'byok' ? 'byok' : 'proxy') }, "POST");
}

// 把刚拿到的 GRS key 合并加密存进本地 user 文件. 失败不抛.
async function _persistComputeStateToUserFile(patch) {
    try {
        var saved = await lsReadFile(LS_USER_FILE);
        if (!saved) return;
        var u = JSON.parse(saved);
        if (patch.key !== undefined) {
            u.grs_api_key_enc = patch.key ? xorEncrypt(String(patch.key)) : "";
        }
        if (patch.mode !== undefined)        u.grs_compute_mode = patch.mode || 'proxy';
        if (patch.key_status !== undefined)  u.grs_key_status = patch.key_status || '';
        if (patch.cap !== undefined)         u.grs_key_cap = patch.cap || 0;
        if (patch.balance !== undefined)     u.grs_balance_cached = patch.balance || 0;
        if (patch.expires_at !== undefined)  u.grs_key_expires_at = patch.expires_at || '';
        if (patch.last_sync_at !== undefined)u.grs_last_sync_at = patch.last_sync_at || '';
        await lsWriteFile(LS_USER_FILE, JSON.stringify(u));
    } catch (e) {
        console.warn("[云服务-compute] 写本地缓存失败:", e.message);
    }
}

// 把 /compute/key 响应规范化成对调用方友好的结构, 同时落盘缓存
function _normalizeComputeKeyRes(res) {
    var ok = !!(res && res.errno === 0);
    var out = {
        success: ok,
        mode: (res && res.mode) || 'proxy',
        key: (res && res.key) || '',
        key_status: (res && res.key_status) || '',
        cap: (res && typeof res.cap === 'number') ? res.cap : 0,
        balance: (res && typeof res.balance_cached === 'number') ? res.balance_cached : 0,
        last_sync_at: (res && res.last_sync_at) || '',
        expires_at: (res && res.expires_at) || '',
        paused_reason: (res && res.paused_reason) || '',
        daily_used: (res && res.daily_used) || 0,
        daily_date: (res && res.daily_date) || '',
        info: (res && res.info) || '',
        error: (res && res.error) || '',
        raw: res
    };
    return out;
}

// 拉一次 compute/key 并写入本地缓存. 给登录后/恢复后调用. 异常吞掉.
async function performComputeKeyRefresh() {
    try {
        var raw = await apiComputeGetKey();
        var norm = _normalizeComputeKeyRes(raw);
        // 即使没建 key (no_balance / no master token), 也把 mode 和 status 记下
        await _persistComputeStateToUserFile({
            key: norm.key,
            mode: norm.mode,
            key_status: norm.key_status,
            cap: norm.cap,
            balance: norm.balance,
            last_sync_at: norm.last_sync_at,
            expires_at: norm.expires_at
        });
        return norm;
    } catch (e) {
        console.warn("[云服务-compute] performComputeKeyRefresh 异常:", e.message);
        return { success: false, error: e.message, mode: 'proxy', key: '' };
    }
}

// 从本地 user 文件取已缓存的 compute 状态 (含解密后的 key). 没有就空对象.
async function getCachedComputeState() {
    try {
        var saved = await lsReadFile(LS_USER_FILE);
        if (!saved) return null;
        var u = JSON.parse(saved);
        var keyPlain = u.grs_api_key_enc ? xorDecrypt(u.grs_api_key_enc) : '';
        return {
            mode: u.grs_compute_mode || 'proxy',
            key: keyPlain,
            key_status: u.grs_key_status || '',
            cap: u.grs_key_cap || 0,
            balance: u.grs_balance_cached || 0,
            last_sync_at: u.grs_last_sync_at || '',
            expires_at: u.grs_key_expires_at || ''
        };
    } catch (e) {
        return null;
    }
}

// 公告  GET /web/announcement  →  { errno:0, content, links }
async function apiGetAnnouncement() {
    return await authRequest("/web/announcement", {}, "GET");
}

// 取云 Forge 公开地址  GET /web/forge-urls  →  { errno:0, urls:[{url,remark,color}] }
// 每条 URL 单独 XOR 加密后回面板, remark/color 明文保留 (面板看不到 URL 明文, 但能展示备注/颜色)
async function apiGetExposedPublicUrl() {
    console.log("[云服务-ForgeURL] apiGetExposedPublicUrl 开始");
    try {
        var res = await authRequest("/web/forge-urls", {}, "GET");
        var list = (res && Array.isArray(res.urls)) ? res.urls : [];
        var out = [];
        list.forEach(function (x) {
            if (x && x.url) {
                out.push({
                    encrypted: xorEncrypt(x.url),
                    remark: x.remark || '',
                    color: x.color || ''
                });
            }
        });
        if (out.length > 0) {
            console.log("[云服务-ForgeURL] 命中 " + out.length + " 条地址(已加密回传)");
            // 兼容老消费者: encrypted = 首条
            return { success: true, urls: out, encrypted: out[0].encrypted };
        }
        console.log("[云服务-ForgeURL] 列表为空, 无可用地址");
    } catch (e) {
        console.error("[云服务-ForgeURL] 获取异常:", e.name, e.message);
    }
    return { success: false };
}

// ===== 完整登录流程 =====
async function performLogin(email, password, remember, rememberPassword) {
    var res = await apiLogin(email, password);
    if (!res || res.errno !== 0) {
        return { success: false, message: (res && res.info) || "登录失败", temporary: !!(res && res.temporary) };
    }
    if (remember || rememberPassword) {
        // 记住密码时邮箱必须一起存, 否则自动重登无从下手
        updateCloudSetting("remember", true, true);
        updateCloudSetting("email", email, true);
    } else {
        updateCloudSetting("remember", false, true);
        updateCloudSetting("email", "", true);
    }
    // 记住密码(XOR 混淆后落盘, 供 token 失效时自动重登; 用户不勾则清掉旧值)
    // btoa 遇到非 Latin-1 字符(如中文密码)会抛错 — 存不进就当没勾, 绝不能砸掉登录本身
    var pwEnc = "";
    if (rememberPassword) { try { pwEnc = xorEncrypt(String(password)); } catch (_) {} }
    updateCloudSetting("pw_enc", pwEnc, true);
    // 归一化: email + access_token 提到顶层, 面板/恢复会话/离线登录都读顶层
    var u = res.user || {};
    var userObj = Object.assign({}, u, { email: u.email || email, access_token: res.access_token });
    await lsWriteFile(LS_USER_FILE, JSON.stringify(userObj));
    updateCloudSetting("offlineMode", false, true);
    setAuthParams({ email: userObj.email, access_token: userObj.access_token });
    // 顺手拉一下 GRS compute key (best-effort, 失败不影响登录)
    var compute = await performComputeKeyRefresh();
    return { success: true, user: userObj, compute: compute };
}

// 离线登录
async function performOfflineLogin() {
    var saved = await lsReadFile(LS_USER_FILE);
    if (typeof saved === "string" && saved) {
        var user = JSON.parse(saved);
        updateCloudSetting("offlineMode", true, true);
        setAuthParams({ email: user.email, access_token: user.access_token });
        // 离线模式只能用本地缓存的 compute key (没法刷新)
        var computeCached = await getCachedComputeState();
        return { success: true, user: user, compute: computeCached };
    }
    return { success: false, message: "未找到本地登录信息,请先联网登录一次" };
}

// 恢复会话
async function tryRestoreSession() {
    await loadCloudSetting();
    var data = await lsReadFile(LS_USER_FILE);
    if (typeof data === "string" && data) {
        try {
            var userInfo = JSON.parse(data);
            if (userInfo.access_token) {
                setAuthParams({ email: userInfo.email, access_token: userInfo.access_token });
                // 不能只凭磁盘里有 token 就宣布登录。先请求一个轻量鉴权接口，
                // 401、过期 token 或网络失败都不制造“假登录”。离线模式须由用户显式进入。
                if (_cloudSetting.offlineMode !== true) {
                    var validation;
                    try {
                        validation = await apiGetUserPoints();
                    } catch (networkErr) {
                        setAuthParams({ email: '', access_token: '' });
                        return {
                            success: false,
                            temporary: true,
                            setting: _cloudSetting,
                            message: (networkErr && networkErr.message) || '暂时无法连接云服务，本地登录信息已保留'
                        };
                    }
                    if (!validation || validation.errno !== 0) {
                        setAuthParams({ email: '', access_token: '' });
                        if (validation && validation.authInvalid) {
                            // token 失效(如在别处登录顶掉/服务端重发 token)。
                            // 有记住的密码就静默重登一次, 成功则用户完全无感。
                            var relogin = await _tryAutoRelogin();
                            if (relogin && relogin.success) return relogin;
                            await lsDeleteFile(LS_USER_FILE);
                            return { success: false, authInvalid: true, setting: _cloudSetting, message: validation.info || '登录已失效，请重新登录' };
                        }
                        return {
                            success: false,
                            temporary: true,
                            setting: _cloudSetting,
                            message: (validation && validation.info) || '暂时无法验证登录，本地登录信息已保留'
                        };
                    }
                    if (validation.user) userInfo = Object.assign({}, userInfo, validation.user, { access_token: userInfo.access_token });
                }
                var cached = await getCachedComputeState();
                performComputeKeyRefresh().catch(function() {});
                return { success: true, user: userInfo, setting: _cloudSetting, compute: cached };
            }
        } catch (e) {
            console.warn("[云服务] cloud_user.json 解析失败:", e && e.message);
        }
    }
    // 本地没有 token 文件(如上次 authInvalid 被清掉), 但记住了密码 → 直接自动登录
    var reloginNoToken = await _tryAutoRelogin();
    if (reloginNoToken && reloginNoToken.success) return reloginNoToken;
    return { success: false, setting: _cloudSetting };
}

// 用记住的密码静默重新登录(只在 token 失效/缺失时调用)。
// 失败不抛错: 返回 null 让调用方走原来的"请重新登录"路径。
// 密码错误(服务端明确拒绝)时清掉已存密码, 避免每次启动都拿错密码撞服务器。
async function _tryAutoRelogin() {
    try {
        var email = _cloudSetting.email;
        var enc = _cloudSetting.pw_enc;
        if (!email || !enc) return null;
        var pw = xorDecrypt(enc);
        if (!pw) return null;
        var res = await performLogin(email, pw, true, true);
        if (res && res.success) {
            console.log("[云服务] token 失效, 已用记住的密码自动重新登录");
            return { success: true, user: res.user, setting: _cloudSetting, compute: res.compute, reloggedIn: true };
        }
        // temporary=断网/服务器抖动 → 密码可能没错, 保留下次再试; 明确拒绝才清
        if (res && !res.temporary) {
            updateCloudSetting("pw_enc", "", true);
            console.warn("[云服务] 记住的密码已失效(可能已改密), 已清除");
        }
    } catch (e) {
        console.warn("[云服务] 自动重登异常:", e && e.message);
    }
    return null;
}

// 登出
async function performLogout(email) {
    var offline = _cloudSetting.offlineMode === true;
    if (!offline) {
        try { await apiLogout(); } catch (e) {}
    }
    setAuthParams({ email: "", access_token: "" });
    // 登出必须删除持久令牌；仅清内存会导致重启后自动重新登录。
    await lsDeleteFile(LS_USER_FILE);
    // 主动登出 = 用户明确要退出, 记住的密码一并清除(否则下次启动又被自动登回来)。
    updateCloudSetting('pw_enc', '', true);
    updateCloudSetting('offlineMode', false, true);
    return { success: true };
}

// 使用加密URL测试Forge连接（验证云服务器是否可用）
async function testCloudForgeConnection(encryptedUrl) {
    var url = xorDecrypt(encryptedUrl);
    if (!url) return { success: false, error: "无效的云服务URL" };
    if (url.endsWith("/")) url = url.slice(0, -1);
    try {
        var resp = await serverConfig.fetchWithTimeout(url + "/sdapi/v1/sd-models", { method: "GET" }, 15000);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        var models = await resp.json();
        if (Array.isArray(models) && models.length > 0) {
            return { success: true, encrypted: encryptedUrl, modelCount: models.length };
        }
        return { success: false, error: "云服务器暂时歇逼了，联系夏三七修复" };
    } catch (e) {
        return { success: false, error: "云服务器暂时歇逼了，联系夏三七修复\n(" + e.message + ")" };
    }
}

// 使用加密URL拉取模型列表
async function fetchCloudModels(encryptedUrl) {
    var url = xorDecrypt(encryptedUrl);
    if (!url) return { success: false, error: "无效的云服务URL" };
    if (url.endsWith("/")) url = url.slice(0, -1);
    try {
        var resp = await serverConfig.fetchWithTimeout(url + "/sdapi/v1/sd-models", { method: "GET" }, 15000);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        var models = await resp.json();
        return { success: true, models: models };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 解密URL（供 forge 宿主临时取明文直连，绝不外传面板）
function decryptUrl(encryptedUrl) {
    return xorDecrypt(encryptedUrl);
}

// ===== 导出 =====
module.exports = {
    loadCloudSetting: loadCloudSetting,
    getCloudSetting: getCloudSetting,
    updateCloudSetting: updateCloudSetting,
    setAuthParams: setAuthParams,
    apiLogin: apiLogin,
    apiRegister: apiRegister,
    apiLogout: apiLogout,
    apiGetCaptcha: apiGetCaptcha,
    apiGetUserPoints: apiGetUserPoints,
    apiConsumePoints: apiConsumePoints,
    apiRechargeByCardKey: apiRechargeByCardKey,
    apiResetPasswordByCard: apiResetPasswordByCard,
    apiGetAnnouncement: apiGetAnnouncement,
    apiGetExposedPublicUrl: apiGetExposedPublicUrl,
    // ----- GRS 算力 (Stage 4) -----
    apiComputeGetKey: apiComputeGetKey,
    apiComputeRefill: apiComputeRefill,
    apiComputeSync: apiComputeSync,
    apiComputeSetByok: apiComputeSetByok,
    performComputeKeyRefresh: performComputeKeyRefresh,
    getCachedComputeState: getCachedComputeState,
    // ------------------------------
    performLogin: performLogin,
    performOfflineLogin: performOfflineLogin,
    tryRestoreSession: tryRestoreSession,
    performLogout: performLogout,
    testCloudForgeConnection: testCloudForgeConnection,
    fetchCloudModels: fetchCloudModels,
    decryptUrl: decryptUrl,
    xorEncrypt: xorEncrypt,
    xorDecrypt: xorDecrypt
};
