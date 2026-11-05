// 网络工具: 只保留通用能力 (fetchWithTimeout / 响应生命周期绑定)。
// 原版这里还定义三个指向作者后台的地址常量, 并提供 fetchApi / url 两个便捷函数;
// 去云化后这些全部删除 (见 docs/去云化评估.md §3.3)。
// 翻译 / 提示词优化 / 海报自动填充都直连用户自己的 OpenAI 兼容接口
// (host/aux-llm.js), 已经没有任何地方需要 fetchApi / url。
(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WheelchairServerConfig = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function() {
  'use strict';
  var DEFAULT_TIMEOUT_MS = 8000;

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

  return {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    fetchWithTimeout: fetchWithTimeout
  };
}));
