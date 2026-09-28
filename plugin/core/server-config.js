// 统一云服务地址。
// 只有一个后台: cpolar。以后要换正式域名, 改 OFFICIAL_BASE 一行即可全插件切换。
// FALLBACK_BASE 与 OFFICIAL_BASE 相同 = 关闭回退(fetchApi 只请求一次, 不重发)。
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WheelchairServerConfig = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function() {
  'use strict';
  var OFFICIAL_BASE = 'https://xiasanqi.cpolar.top';
  var FALLBACK_BASE = OFFICIAL_BASE;   // 备用站已停用; fetchApi 内 primary===fallback 时自动不回退

  // DLSS 专用入口。指向同一台 preset-server(3737), 只是换了一条 cpolar VIP 线路。
  // 实测(2026-09-07): 主域名走 cn_top 只有 ~2Mbps, 这条 cn_vip 有 ~22Mbps, 差 10 倍。
  // DLSS 要传几十 MB 的图, 只有它值得单开一条; 其余接口流量很小, 继续走主域名。
  // 这条线断了会自动回退到 OFFICIAL_BASE(慢但能用), 见 _dlssReq。
  var DLSS_BASE = 'https://xiasanqiforge.vip.cpolar.cn';
  var FALLBACK_STATUS = { 404: true, 500: true, 502: true, 503: true, 504: true };
  var DEFAULT_TIMEOUT_MS = 8000;

  function trimBase(base) { return String(base || '').replace(/\/+$/, ''); }
  function toPath(path) {
    path = String(path || '');
    if (/^https?:\/\//i.test(path)) return path;
    return path.charAt(0) === '/' ? path : '/' + path;
  }
  function url(path, base) { return trimBase(base || OFFICIAL_BASE) + toPath(path); }
  function shouldFallback(status) { return !!FALLBACK_STATUS[status] || status >= 500; }

  function makeAbortError() {
    var err = new Error('请求已取消');
    err.name = 'AbortError';
    return err;
  }

  function makeTimeoutError(timeoutMs) {
    var err = new Error('请求超时（' + Math.ceil(timeoutMs / 1000) + ' 秒）');
    err.name = 'TimeoutError';
    err.code = 'ETIMEDOUT';
    return err;
  }

  // 让超时覆盖响应体读取，而不只覆盖“收到响应头”这一小段。
  function bindResponseLifetime(response, state, cleanup) {
    var methods = ['arrayBuffer', 'blob', 'formData', 'json', 'text'];
    methods.forEach(function(method) {
      var original = response && response[method];
      if (typeof original !== 'function') return;
      try {
        response[method] = function() {
          var result;
          try {
            result = original.apply(response, arguments);
          } catch (err) {
            cleanup();
            if (state.timedOut) throw makeTimeoutError(state.timeoutMs);
            throw err;
          }
          return Promise.resolve(result).then(function(value) {
            cleanup();
            return value;
          }, function(err) {
            cleanup();
            if (state.timedOut) throw makeTimeoutError(state.timeoutMs);
            throw err;
          });
        };
      } catch (_) {
        // 某些 UXP 版本的 Response 方法不可覆写；计时器仍会真实 abort 底层请求。
      }
    });
    try { response._wheelchairRequestCleanup = cleanup; } catch (_) {}
    return response;
  }

  function cleanupResponse(response) {
    try {
      if (response && typeof response._wheelchairRequestCleanup === 'function') {
        response._wheelchairRequestCleanup();
      }
    } catch (_) {}
  }

  async function fetchWithTimeout(requestUrl, init, timeoutMs) {
    var requestInit = init ? Object.assign({}, init) : {};
    var externalSignal = requestInit.signal;
    if (externalSignal && externalSignal.aborted) throw makeAbortError();

    timeoutMs = Number(timeoutMs);
    if (!(timeoutMs > 0)) timeoutMs = DEFAULT_TIMEOUT_MS;

    var controller = new AbortController();
    var state = { timedOut: false, timeoutMs: timeoutMs };
    var cleaned = false;
    var timer = null;
    var onExternalAbort = function() {
      try { controller.abort(); } catch (_) {}
    };
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeout(timer);
      if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
    }

    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
    timer = setTimeout(function() {
      state.timedOut = true;
      try { controller.abort(); } catch (_) {}
    }, timeoutMs);
    requestInit.signal = controller.signal;

    try {
      var response = await fetch(requestUrl, requestInit);
      return bindResponseLifetime(response, state, cleanup);
    } catch (err) {
      cleanup();
      if (state.timedOut) throw makeTimeoutError(timeoutMs);
      throw err;
    }
  }

  async function fetchApi(path, init, options) {
    options = options || {};
    var primary = trimBase(options.primary || OFFICIAL_BASE);
    var fallback = trimBase(options.fallback || FALLBACK_BASE);
    var allowFallback = options.allowFallback !== false && primary !== fallback;
    var requestPath = toPath(path);
    var requestInit = init ? Object.assign({}, init) : {};
    var signal = requestInit.signal;
    if (signal && signal.aborted) throw new Error('请求已取消');

    var attemptTimeoutMs = Number(options.timeoutMs);
    if (!(attemptTimeoutMs > 0)) attemptTimeoutMs = signal ? 0 : DEFAULT_TIMEOUT_MS;

    try {
      var primaryResponse = signal && !attemptTimeoutMs
        ? await fetch(primary + requestPath, requestInit)
        : await fetchWithTimeout(primary + requestPath, requestInit, attemptTimeoutMs);
      if (!allowFallback || !shouldFallback(primaryResponse.status)) return primaryResponse;
      try { if (primaryResponse.body && primaryResponse.body.cancel) primaryResponse.body.cancel(); } catch (_) {}
      cleanupResponse(primaryResponse);
    } catch (primaryErr) {
      if (!allowFallback || (signal && signal.aborted)) throw primaryErr;
    }

    // JSON/string/FormData 请求在本项目内可重复发送；调用方若使用一次性流，
    // 可传 allowFallback:false，避免重试造成半截上传。
    return signal && !attemptTimeoutMs
      ? await fetch(fallback + requestPath, requestInit)
      : await fetchWithTimeout(fallback + requestPath, requestInit, attemptTimeoutMs);
  }

  return {
    OFFICIAL_BASE: OFFICIAL_BASE,
    FALLBACK_BASE: FALLBACK_BASE,
    DLSS_BASE: DLSS_BASE,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    url: url,
    fetchWithTimeout: fetchWithTimeout,
    fetchApi: fetchApi,
    shouldFallback: shouldFallback
  };
}));
