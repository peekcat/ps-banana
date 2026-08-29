// ============================================================
//  tile-chat.js — AI 助手聊天磁贴 (D1+D2+D3)
//  D1: 会话列表 / 消息流 / 流式响应 / 输入框 / 停止 / 清空
//  D2: 角色系统 (9内置 + 自定义CRUD + 每会话绑定)
//  D3: 图片附件 + JSON块可视化
// ============================================================
(function() {
'use strict';

// ── 常量 ──

var DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
var DEFAULT_MODEL = 'gpt-4o-mini';
var SAVE_DEBOUNCE_MS = 2000;
var MAX_ATTACHMENTS = 4;
var _netConfig = window.WheelchairServerConfig;

// ── 附件体积治理 (2026-07-04, 修 macOS 打开黑屏 / Windows 用久 OOM) ──
//  病根: 附件 base64 原样进聊天记录且永不压缩, 历史越攒越大;
//  打开时全量渲染 + 每次发送全量重发 → macOS webview 进程被系统掐死(黑屏), Windows 缓慢涨到 OOM
var ATTACH_MAX_DIM = 1536;                        // 附件最长边, 超过就缩(AI 识图够用)
var ATTACH_HEAVY_B64 = 600 * 1024;                // base64 超过这个长度视为"大图", 后台瘦身
var ATTACH_PLACEHOLDER_B64 = 2 * 1024 * 1024;     // 超过这个长度的老图先不上 DOM, 等瘦身完再显示

// 从 base64 头部字节猜图片格式(附件历史上没存 mime, 全按 png 写死是不对的)
function _sniffMime(b64) {
  if (!b64) return 'image/png';
  if (b64.indexOf('/9j/') === 0) return 'image/jpeg';
  if (b64.indexOf('iVBOR') === 0) return 'image/png';
  if (b64.indexOf('R0lGOD') === 0) return 'image/gif';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  return 'image/png';
}

// 把图片 base64 限制到 ATTACH_MAX_DIM 最长边并重编码 JPEG(垫白底)。
// 只在结果确实更小时才替换; 解码失败一律回退原图, 保证不丢用户数据。cb(base64)
function _normalizeAttachment(base64, cb) {
  try {
    if (!base64 || typeof base64 !== 'string') { cb(base64); return; }
    var img = new Image();
    img.onload = function() {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { cb(base64); return; }
        var scale = Math.min(1, ATTACH_MAX_DIM / Math.max(w, h));
        if (scale >= 1 && base64.length < ATTACH_HEAVY_B64) { cb(base64); return; }  // 本来就小 → 不动
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#ffffff';           // JPEG 没有透明, 垫白底
        cx.fillRect(0, 0, cw, ch);
        cx.drawImage(img, 0, 0, cw, ch);
        var out = cv.toDataURL('image/jpeg', 0.85);
        var comma = out.indexOf(',');
        var newB64 = comma > 0 ? out.slice(comma + 1) : '';
        if (newB64 && newB64.length < base64.length) cb(newB64);
        else cb(base64);
      } catch (e) { cb(base64); }
    };
    img.onerror = function() { cb(base64); };
    img.src = 'data:' + _sniffMime(base64) + ';base64,' + base64;
  } catch (e) { cb(base64); }
}

// 老聊天记录后台瘦身: 一张一张把历史大图压小(串行, 避免内存冲顶), 完事保存+重绘。
// 幂等: 压过的图不会再超阈值, 重复调用等于空转。
var _attachMigrating = false;
function _migrateHeavyAttachments() {
  if (_attachMigrating) return;
  var queue = [];
  for (var s = 0; s < _sessions.length; s++) {
    var msgs = _sessions[s].messages || [];
    for (var m = 0; m < msgs.length; m++) {
      var atts = msgs[m].attachments;
      if (!atts) continue;
      for (var a = 0; a < atts.length; a++) {
        if (atts[a] && atts[a].data && atts[a].data.length > ATTACH_HEAVY_B64) queue.push(atts[a]);
      }
    }
  }
  if (queue.length === 0) return;
  _attachMigrating = true;
  var idx = 0, shrunk = 0;
  function next() {
    if (idx >= queue.length) {
      _attachMigrating = false;
      if (shrunk > 0) {
        _scheduleSave();
        _renderIfActiveChat();
        try { TileAPI.log('AI助手: 已压缩 ' + shrunk + ' 张历史聊天大图(防黑屏/内存溢出)', 'info'); } catch (e) {}
      }
      return;
    }
    var att = queue[idx++];
    _normalizeAttachment(att.data, function(newB64) {
      if (newB64 && newB64.length < att.data.length) { att.data = newB64; shrunk++; }
      setTimeout(next, 60);   // 喘口气, 别挤占正常渲染
    });
  }
  next();
}

function _renderIfActiveChat() {
  if (_activeContainer) { try { _renderMessages(_activeContainer); } catch (e) {} }
}

// ── 9 个内置角色 ──
// 初始硬编码版本为 fallback,实际运行时会被 builtin_roles.json 的完整长提示词覆盖
// (那些提示词质量远高于这里的精简版)

var BUILTIN_ROLES = [
  { id: 'role_retoucher', icon: '\uD83C\uDFA8', name: '通用修图助手', description: '默认角色，综合修图建议',
    systemPrompt: '你是一个专业的 Photoshop 修图助手。用中文简洁回答用户的修图相关问题，给出具体的修图建议和操作步骤。' },
  { id: 'role_photographer', icon: '\uD83D\uDCF8', name: '摄影后期师', description: '胶片色调/光影/调色',
    systemPrompt: '你是一位专业摄影后期师。擅长胶片色调模拟、光影氛围营造、色温色调调整。请用摄影后期专业术语回答，给出具体的调色参数建议（色温K值、曲线形态、HSL偏移等）。' },
  { id: 'role_portrait', icon: '\uD83D\uDC64', name: '人像精修师', description: '磨皮/轮廓/五官精修',
    systemPrompt: '你是一位资深人像精修师。专注高低频分离磨皮、面部轮廓优化、五官精修。请给出具体的人像精修步骤和参数，保证自然感，避免塑料/蜡像质感。' },
  { id: 'role_makeup', icon: '\uD83C\uDFAD', name: '化妆师', description: '妆容调整/色彩搭配',
    systemPrompt: '你是一位数字化妆师。擅长妆容风格设计、唇妆眼妆腮红调整、肤色均匀化。请根据用户需求给出妆容调整的具体方案和色彩搭配建议。' },
  { id: 'role_costume', icon: '\uD83D\uDC55', name: '服装师', description: '服装纹理/颜色/材质',
    systemPrompt: '你是一位服装纹理专家。擅长服装材质优化、颜色校正、纹理细节增强。请使用PBR材质术语（Roughness/Metalness等）给出具体的服装修饰建议。' },
  { id: 'role_lighting', icon: '\uD83D\uDCA1', name: '光影设计师', description: '灯光重打/光影重构',
    systemPrompt: '你是一位光影设计师。擅长光源布局设计（伦勃朗光/蝴蝶光/环形光等）、光比调节、体积雾效果。请用专业布光术语给出光影方案，包含色温K值和光照强度。' },
  { id: 'role_scene', icon: '\uD83C\uDF04', name: '场景师', description: '背景替换/天气/氛围',
    systemPrompt: '你是一位场景合成VFX专家。擅长背景替换、天气氛围营造、环境光重建。请给出场景合成方案，注意人物与新场景的光影融合和边缘过渡。' },
  { id: 'role_vfx', icon: '\u2728', name: '特效师', description: '魔法光效/粒子/特效',
    systemPrompt: '你是一位视觉特效师。擅长魔法光效、粒子系统、能量场效果设计。请给出具体的特效实现方案，包含粒子参数、光效色彩和混合模式。' },
  { id: 'role_technical', icon: '\uD83C\uDFAF', name: '技术调校师', description: '尺寸/比例/格式/分辨率',
    systemPrompt: '你是一位技术调校专家。擅长图片尺寸调整、比例裁切、格式转换、分辨率优化、色彩空间管理。请给出具体的技术参数建议。' }
];

var _builtinRolesLoaded = false;

// 从 builtin_roles.json 加载完整长提示词,覆盖硬编码的 fallback
// JSON 字段 {icon, name, desc, prompt} → 转成 v6 格式 {id, icon, name, description, systemPrompt}
function _loadBuiltinRolesFromFile() {
  if (_builtinRolesLoaded) return Promise.resolve();
  return fetch('builtin_roles.json')
    .then(function(resp) { return resp.json(); })
    .then(function(data) {
      if (!Array.isArray(data) || data.length === 0) return;
      var hardcodedIds = BUILTIN_ROLES.map(function(r) { return r.id; });
      BUILTIN_ROLES = data.map(function(item, i) {
        return {
          id: hardcodedIds[i] || ('role_builtin_' + i),
          icon: item.icon || '',
          name: item.name || ('角色' + (i + 1)),
          description: item.desc || '',
          systemPrompt: item.prompt || '',
          builtin: true
        };
      });
      _builtinRolesLoaded = true;
      TileAPI.log('[tile-chat] 内置角色加载完成 (' + BUILTIN_ROLES.length + ' 个)', 'info');
      TileAPI.emit('chat:builtinRolesLoaded');
    })
    .catch(function(err) {
      TileAPI.log('[tile-chat] builtin_roles.json 加载失败,使用 fallback: ' + (err && err.message || err), 'warn');
    });
}
_loadBuiltinRolesFromFile();

// ── 运行时状态 ──

var _sessions = [];
var _currentId = null;
var _generating = false;
var _abortController = null;
var _saveTimer = null;
var _activeContainer = null;
var _customRoles = [];
var _pendingAttachments = []; // base64 strings

// ── 工具函数 ──

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _genId() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
}

function _now() { return Date.now(); }

// ── 配置读取 ──
// AI 助手强制使用自己的独立配置(chat.url / chat.key / chat.model),不再继承生成磁贴
// 用户必须在 chat 磁贴的⚙设置中单独填 URL/Key/Model
function _getUseInherit() { return false; }
function _getUrl() {
  return TileAPI.storage.get('chat.url') || DEFAULT_URL;
}
function _getKey() {
  return TileAPI.storage.get('chat.key') || '';
}
function _getModel() {
  return TileAPI.storage.get('chat.model') || DEFAULT_MODEL;
}
function _getMaxTokens() {
  var v = parseInt(TileAPI.storage.get('chat.maxTokens'), 10);
  return (v > 0 && v <= 131072) ? v : 4096;
}
function _getTemperature() {
  var v = parseFloat(TileAPI.storage.get('chat.temperature'));
  return (v >= 0 && v <= 2) ? v : 0.9;
}

function _currentSession() {
  if (!_currentId) return null;
  for (var i = 0; i < _sessions.length; i++) {
    if (_sessions[i].id === _currentId) return _sessions[i];
  }
  return null;
}

function _createSession(title) {
  var s = {
    id: _genId(),
    title: title || '未命名对话',
    roleId: BUILTIN_ROLES[0].id,
    messages: [],
    createdAt: _now(),
    updatedAt: _now()
  };
  _sessions.unshift(s);
  _currentId = s.id;
  return s;
}

// ── 角色相关 ──

function _loadCustomRoles() {
  var saved = TileAPI.storage.get('chat.customRoles');
  if (saved && Array.isArray(saved)) _customRoles = saved;
}

function _saveCustomRoles() {
  // 不打印角色内容: 用户自定义的系统提示词属其资产, 不进 console (bug #48)
  TileAPI.storage.set('chat.customRoles', _customRoles);
}

function _allRoles() {
  return BUILTIN_ROLES.concat(_customRoles);
}

function _findRole(roleId) {
  var all = _allRoles();
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === roleId) return all[i];
  }
  return BUILTIN_ROLES[0];
}

function _sessionRole(session) {
  if (!session) return BUILTIN_ROLES[0];
  return _findRole(session.roleId || BUILTIN_ROLES[0].id);
}

// ── 持久化 ──

function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function() {
    _saveTimer = null;
    _doSave();
  }, SAVE_DEBOUNCE_MS);
}

function _doSave() {
  var payload = { sessions: _sessions, currentId: _currentId };
  TileAPI.storage.set('chat.sessions', payload);
  TileAPI.sendToHost('saveChatData', { type: 'sessions', data: payload });
}

function _loadData(cb) {
  var stored = TileAPI.storage.get('chat.sessions');
  if (stored && stored.sessions && stored.sessions.length > 0) {
    _sessions = stored.sessions;
    _currentId = stored.currentId || (_sessions[0] && _sessions[0].id) || null;
    if (cb) cb();
    return;
  }
  TileAPI.sendToHost('loadChatData', { type: 'sessions' });
}

// ── 流式 fetch ──

function _buildApiMessages(session) {
  var role = _sessionRole(session);
  var apiMessages = [{ role: 'system', content: role.systemPrompt }];

  // bug ⑤ B 决策:不再按模型名白名单过滤多模态。
  // 只要消息带 attachments 就以 OpenAI 视觉格式发送;若模型不支持,服务端会回错,
  // 由 _sendToApi 的 onError 弹 toast 提示用户(避免"附了图但悄悄没传"的迷惑情况)。
  for (var i = 0; i < session.messages.length; i++) {
    var m = session.messages[i];
    if (m.role === 'system') continue;
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        var contentArr = [{ type: 'text', text: m.content || '' }];
        for (var j = 0; j < m.attachments.length; j++) {
          contentArr.push({
            type: 'image_url',
            image_url: { url: 'data:' + _sniffMime(m.attachments[j].data) + ';base64,' + m.attachments[j].data }
          });
        }
        apiMessages.push({ role: 'user', content: contentArr });
      } else {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }
  }
  return apiMessages;
}

function _sendToApi(messages, onChunk, onDone, onError) {
  var url = _getUrl();
  var key = _getKey();
  var model = _getModel();

  if (!key) { onError('请先在聊天设置或 AI 生成磁贴中配置 API Key'); return null; }
  if (!url) { onError('API URL 为空,请在聊天设置中配置'); return null; }
  if (!model) { onError('未指定模型,请在聊天设置中配置'); return null; }

  // 规范化 URL — 自动补全 /v1/chat/completions 路径
  var normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    onError('API URL 必须以 http:// 或 https:// 开头,当前: ' + normalizedUrl);
    return null;
  }
  // 去掉末尾斜杠
  normalizedUrl = normalizedUrl.replace(/\/+$/, '');
  // 根据当前尾巴补全路径
  if (/\/chat\/completions$/i.test(normalizedUrl)) {
    // 已完整,不动
  } else if (/\/completions$/i.test(normalizedUrl)) {
    // 某些老接口(/v1/completions)保留
  } else if (/\/v\d+$/i.test(normalizedUrl)) {
    // .../v1 → 追加 /chat/completions
    normalizedUrl += '/chat/completions';
  } else {
    // 裸域名或带路径前缀 → 追加 /v1/chat/completions
    normalizedUrl += '/v1/chat/completions';
  }
  var urlHint = '(实际请求: ' + normalizedUrl + ')';

  _abortController = new AbortController();

  var body = JSON.stringify({
    model: model,
    stream: true,
    messages: messages,
    temperature: _getTemperature(),
    max_tokens: _getMaxTokens()
  });

  console.log('[tile-chat] 发起请求:', { url: normalizedUrl, model: model, msgCount: messages.length });

  // 15 分钟超时(大模型慢响应)
  var timeoutTimer = setTimeout(function() {
    try { _abortController && _abortController.abort(); } catch(e) {}
    onError('请求超时(15 分钟无响应)');
  }, 15 * 60 * 1000);

  var firstChunkReceived = false;
  var totalChunks = 0;

  fetch(normalizedUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: body,
    signal: _abortController.signal
  }).then(function(resp) {
    console.log('[tile-chat] HTTP 响应:', resp.status, resp.statusText);
    if (!resp.ok) {
      return resp.text().then(function(t) {
        var hints = {
          400: '请求格式错误(模型名是否正确?)',
          401: 'API Key 无效或过期',
          402: '余额不足',
          403: '权限不足',
          404: '模型不存在或 API 路径错误 ' + urlHint,
          422: '参数错误(模型不支持 stream?)',
          429: '请求太频繁',
          500: '服务器内部错误',
          502: '网关错误',
          503: '服务暂时不可用',
          504: '网关超时'
        };
        var hint = hints[resp.status] || '';
        throw new Error('HTTP ' + resp.status + (hint ? ' ' + hint : '') + (t ? ' — ' + t.substring(0, 300) : ''));
      });
    }
    // 检查响应类型 — 非 SSE/stream 的情况(某些代理返回整体 JSON)
    var ctype = resp.headers.get('content-type') || '';
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // 老浏览器环境 fallback:一次性读完整 JSON
      return resp.text().then(function(t) {
        _tryParseFullResponse(t, onChunk, onDone, onError);
      });
    }
    if (ctype.indexOf('application/json') === 0 && ctype.indexOf('stream') === -1) {
      // 代理把流式响应折叠成了一整段 JSON
      return resp.text().then(function(t) {
        _tryParseFullResponse(t, onChunk, onDone, onError);
      });
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var parseErrors = 0;
    var nonDataLines = 0;
    var rawSample = '';  // 收集前 500 字用于诊断

    function pump() {
      return reader.read().then(function(result) {
        if (result.done) {
          clearTimeout(timeoutTimer);
          // 检查是否有 chunk 进来过
          if (totalChunks === 0) {
            var diag = '响应未返回任何内容';
            if (nonDataLines > 0 && parseErrors === 0) {
              diag += ' — 响应不是标准 SSE 格式(可能 API 不支持 stream 或路径错误)';
            }
            if (parseErrors > 0) {
              diag += ' — ' + parseErrors + ' 次解析错误';
            }
            if (rawSample) diag += '\n原始响应片段: ' + rawSample;
            onError(diag);
            return;
          }
          onDone();
          return;
        }
        var piece = decoder.decode(result.value, { stream: true });
        if (rawSample.length < 500) rawSample += piece;
        buffer += piece;
        var lines = buffer.split('\n');
        buffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          if (!line.startsWith('data:')) {
            nonDataLines++;
            // 尝试把整行当 JSON(非标准 SSE 的 fallback)
            if (line.charAt(0) === '{') {
              try {
                var j2 = JSON.parse(line);
                if (j2.error) {
                  onError('API 错误: ' + (j2.error.message || JSON.stringify(j2.error)));
                  try { reader.cancel(); } catch(e) {}
                  clearTimeout(timeoutTimer);
                  return;
                }
              } catch(_) {}
            }
            continue;
          }
          var data = line.slice(5).trim();
          if (data === '[DONE]') {
            clearTimeout(timeoutTimer);
            if (totalChunks === 0) {
              onError('API 返回 [DONE] 但没有任何内容(可能模型被过滤或配额不足)');
              return;
            }
            onDone();
            return;
          }
          try {
            var json = JSON.parse(data);
            // 检查是否是错误包
            if (json.error) {
              onError('API 错误: ' + (json.error.message || JSON.stringify(json.error)));
              try { reader.cancel(); } catch(e) {}
              clearTimeout(timeoutTimer);
              return;
            }
            var delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              totalChunks++;
              firstChunkReceived = true;
              onChunk(delta.content);
            }
            // finish_reason 有时带诊断信息
            var finish = json.choices && json.choices[0] && json.choices[0].finish_reason;
            if (finish && finish !== 'stop' && finish !== 'length' && finish !== null) {
              console.warn('[tile-chat] finish_reason:', finish);
            }
          } catch(e) {
            parseErrors++;
            if (parseErrors <= 3) console.warn('[tile-chat] SSE 解析错误:', e.message, 'data:', data.substring(0, 200));
          }
        }
        return pump();
      });
    }
    return pump();
  }).catch(function(err) {
    clearTimeout(timeoutTimer);
    if (err.name === 'AbortError') { onDone(); return; }
    // fetch 底层失败 — 错误信息对用户不友好,加提示
    var msg = err.message || '请求失败';
    if (msg.indexOf('Failed to fetch') >= 0 || msg.indexOf('NetworkError') >= 0) {
      msg = '网络请求失败 — 请检查: 1) API URL 是否可访问 2) 是否被防火墙/代理拦截 3) UXP 是否允许访问该地址';
    } else if (msg.indexOf('CORS') >= 0) {
      msg = 'CORS 跨域错误 — API 服务器未允许 UXP 环境访问';
    }
    onError(msg);
  });

  return _abortController;
}

// 非流式响应解析(代理把 stream 折叠成整体 JSON 的情况)
function _tryParseFullResponse(text, onChunk, onDone, onError) {
  try {
    var json = JSON.parse(text);
    if (json.error) {
      onError('API 错误: ' + (json.error.message || JSON.stringify(json.error)));
      return;
    }
    // OpenAI 非流式格式
    var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (content) {
      onChunk(content);
      onDone();
      return;
    }
    onError('API 响应格式未识别: ' + text.substring(0, 300));
  } catch(e) {
    onError('API 响应解析失败: ' + e.message + ' — 前 300 字: ' + text.substring(0, 300));
  }
}

// ── JSON 块可视化 ──

// ── Markdown 渲染(移植自 5.4.6) ──
function _markdownToHtml(text) {
  var html = _esc(text);
  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code class="chat-md-code">$1</code>');
  // 粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 斜体(排除已处理的 **)
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<div class="chat-md-h3">$1</div>');
  html = html.replace(/^## (.+)$/gm, '<div class="chat-md-h2">$1</div>');
  html = html.replace(/^# (.+)$/gm, '<div class="chat-md-h1">$1</div>');
  // 无序列表
  html = html.replace(/(^|\n)((?:- .+\n?)+)/g, function(_, pre, block) {
    var items = block.trim().split('\n').map(function(line) {
      return '<li>' + line.replace(/^- /, '') + '</li>';
    }).join('');
    return pre + '<ul class="chat-md-ul">' + items + '</ul>';
  });
  // 有序列表
  html = html.replace(/(^|\n)((?:\d+\. .+\n?)+)/g, function(_, pre, block) {
    var items = block.trim().split('\n').map(function(line) {
      return '<li>' + line.replace(/^\d+\. /, '') + '</li>';
    }).join('');
    return pre + '<ol class="chat-md-ol">' + items + '</ol>';
  });
  // 换行
  html = html.replace(/\n/g, '<br>');
  // 清理块元素前后多余 <br>
  html = html.replace(/<br>\s*(<(?:div|ul|ol))/g, '$1');
  html = html.replace(/(<\/(?:div|ul|ol)>)\s*<br>/g, '$1');
  return html;
}

// ── JSON 语法高亮 ──
function _syntaxHighlightJSON(jsonStr) {
  try { jsonStr = JSON.stringify(JSON.parse(jsonStr), null, 2); } catch(e) {}
  return _esc(jsonStr)
    .replace(/"([^"\\]|\\.)*"\s*:/g, function(m) { return '<span class="chat-json-key">' + m + '</span>'; })
    .replace(/: ("([^"\\]|\\.)*")/g, function(m, s) { return ': <span class="chat-json-string">' + s + '</span>'; })
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, function(m) { return '<span class="chat-json-number">' + m + '</span>'; })
    .replace(/\b(true|false)\b/g, function(m) { return '<span class="chat-json-bool">' + m + '</span>'; })
    .replace(/\bnull\b/g, '<span class="chat-json-null">null</span>');
}

// 从文本中提取 ``` 代码块 / JSON,其余走 markdown
// 返回完整 HTML 字符串
function _renderContentWithJson(rawText) {
  if (!rawText) return '';
  var text = String(rawText);
  // 先按 ``` 代码块切分
  var parts = text.split(/(```\w*\s*\n[\s\S]*?\n```)/g);

  if (parts.length === 1) {
    // 无代码块 — 检测裸 JSON
    var trimmed = text.trim();
    var isJson = (trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') ||
                 (trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']');
    if (isJson) {
      try { JSON.parse(trimmed); return _makeJsonBlockHtml(trimmed); } catch(e) {}
    }
    // 走 markdown
    return '<div class="chat-md">' + _markdownToHtml(text) + '</div>';
  }

  var html = '';
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part) continue;
    var codeMatch = part.match(/^```(\w*)\s*\n([\s\S]*?)\n```$/);
    if (codeMatch) {
      var lang = (codeMatch[1] || '').toLowerCase();
      var code = codeMatch[2].trim();
      // JSON 代码块 → 高亮 + 按钮
      if (lang === 'json' || (!lang && code.charAt(0) === '{')) {
        try { JSON.parse(code); html += _makeJsonBlockHtml(code); continue; } catch(e) {}
      }
      html += _makeCodeBlockHtml(lang, code);
    } else if (part.trim()) {
      html += '<div class="chat-md">' + _markdownToHtml(part) + '</div>';
    }
  }
  return html;
}

function _makeJsonBlockHtml(jsonStr) {
  var id = 'jsonblk_' + _genId();
  // 把原始 JSON 用 data-raw 存起来供复制/填入使用(base64 以规避引号转义)
  var raw = encodeURIComponent(jsonStr);
  return '<div class="chat-json-card" data-json-raw="' + raw + '">' +
    '<div class="chat-json-card-header">' +
      '<span class="chat-json-card-label">JSON</span>' +
      '<span class="chat-json-card-actions">' +
        '<button class="chat-json-action-btn" data-jsonact="copy" data-jsonid="' + id + '">📋 复制</button>' +
        '<button class="chat-json-action-btn" data-jsonact="fill" data-jsonid="' + id + '">📝 填入提示词</button>' +
      '</span>' +
    '</div>' +
    '<pre class="chat-json-card-body" id="' + id + '">' + _syntaxHighlightJSON(jsonStr) + '</pre>' +
  '</div>';
}

function _makeCodeBlockHtml(lang, code) {
  var id = 'codeblk_' + _genId();
  var raw = encodeURIComponent(code);
  return '<div class="chat-code-block" data-code-raw="' + raw + '">' +
    '<div class="chat-code-header">' +
      '<span class="chat-code-lang">' + _esc(lang || 'code') + '</span>' +
      '<button class="chat-json-action-btn" data-codeact="copy" data-codeid="' + id + '">📋 复制</button>' +
    '</div>' +
    '<pre class="chat-code-body" id="' + id + '">' + _esc(code) + '</pre>' +
  '</div>';
}

// ── 渲染辅助 ──

function _renderSessionList(container) {
  var listEl = container.querySelector('#chatSessionList');
  if (!listEl) return;
  var html = '';
  for (var i = 0; i < _sessions.length; i++) {
    var s = _sessions[i];
    var active = s.id === _currentId ? ' chat-session-active' : '';
    var role = _sessionRole(s);
    html += '<div class="chat-session-item' + active + '" data-sid="' + s.id + '">' +
      '<span class="chat-session-role-icon">' + role.icon + '</span>' +
      '<span class="chat-session-title">' + _esc(s.title) + '</span>' +
      '<span class="chat-session-actions">' +
        '<button class="chat-session-btn chat-rename-btn" data-sid="' + s.id + '" title="重命名">&#9998;</button>' +
        '<button class="chat-session-btn chat-delete-btn" data-sid="' + s.id + '" title="删除">&times;</button>' +
      '</span>' +
    '</div>';
  }
  listEl.innerHTML = html;

  // 绑定点击
  var items = listEl.querySelectorAll('.chat-session-item');
  for (var j = 0; j < items.length; j++) {
    (function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.classList.contains('chat-rename-btn') || e.target.classList.contains('chat-delete-btn')) return;
        var sid = item.getAttribute('data-sid');
        if (sid !== _currentId) {
          _currentId = sid;
          _pendingAttachments = [];
          _renderAll(container);
          _scheduleSave();
        }
      });
    })(items[j]);
  }

  // 重命名
  var renameBtns = listEl.querySelectorAll('.chat-rename-btn');
  for (var k = 0; k < renameBtns.length; k++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var sid = btn.getAttribute('data-sid');
        var sess = null;
        for (var x = 0; x < _sessions.length; x++) { if (_sessions[x].id === sid) { sess = _sessions[x]; break; } }
        if (!sess) return;
        TileAPI.prompt('重命名对话:', { defaultValue: sess.title }).then(function(v) {
          if (v !== null && v.trim()) {
            sess.title = v.trim();
            _renderSessionList(container);
            _scheduleSave();
          }
        });
      });
    })(renameBtns[k]);
  }

  // 删除
  var delBtns = listEl.querySelectorAll('.chat-delete-btn');
  for (var m = 0; m < delBtns.length; m++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var sid = btn.getAttribute('data-sid');
        TileAPI.confirm('确定删除该对话?').then(function(ok) {
          if (!ok) return;
          _sessions = _sessions.filter(function(s) { return s.id !== sid; });
          if (_currentId === sid) {
            _currentId = _sessions.length > 0 ? _sessions[0].id : null;
          }
          if (_sessions.length === 0) _createSession();
          _renderAll(container);
          _scheduleSave();
          TileAPI.toast('对话已删除', 'info');
        });
      });
    })(delBtns[m]);
  }
}

function _renderSessionStrip(container) {
  var stripEl = container.querySelector('#chatSessionStrip');
  if (!stripEl) return;
  var html = '';
  for (var i = 0; i < _sessions.length; i++) {
    var s = _sessions[i];
    var active = s.id === _currentId ? ' chat-session-chip-active' : '';
    var role = _sessionRole(s);
    html += '<div class="chat-session-chip' + active + '" data-sid="' + s.id + '" title="' + _esc(s.title) + '">' +
      '<span class="chat-session-chip-icon">' + role.icon + '</span>' +
      '<span class="chat-session-chip-title">' + _esc(s.title) + '</span>' +
      '<button class="chat-session-chip-del" data-sid="' + s.id + '" title="删除">&times;</button>' +
    '</div>';
  }
  stripEl.innerHTML = html;

  var chips = stripEl.querySelectorAll('.chat-session-chip');
  for (var j = 0; j < chips.length; j++) {
    (function(chip) {
      chip.addEventListener('click', function(e) {
        if (e.target.classList.contains('chat-session-chip-del')) return;
        var sid = chip.getAttribute('data-sid');
        if (sid !== _currentId) {
          _currentId = sid;
          _pendingAttachments = [];
          _renderAll(container);
          _scheduleSave();
        }
      });
      // 双击重命名
      chip.addEventListener('dblclick', function(e) {
        if (e.target.classList.contains('chat-session-chip-del')) return;
        var sid = chip.getAttribute('data-sid');
        var sess = null;
        for (var x = 0; x < _sessions.length; x++) { if (_sessions[x].id === sid) { sess = _sessions[x]; break; } }
        if (!sess) return;
        TileAPI.prompt('重命名对话:', { defaultValue: sess.title }).then(function(v) {
          if (v !== null && v.trim()) {
            sess.title = v.trim();
            _renderSessionStrip(container);
            _scheduleSave();
          }
        });
      });
    })(chips[j]);
  }

  var delBtns = stripEl.querySelectorAll('.chat-session-chip-del');
  for (var k = 0; k < delBtns.length; k++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var sid = btn.getAttribute('data-sid');
        TileAPI.confirm('确定删除该对话?').then(function(ok) {
          if (!ok) return;
          _sessions = _sessions.filter(function(s) { return s.id !== sid; });
          if (_currentId === sid) {
            _currentId = _sessions.length > 0 ? _sessions[0].id : null;
          }
          if (_sessions.length === 0) _createSession();
          _renderAll(container);
          _scheduleSave();
          TileAPI.toast('对话已删除', 'info');
        });
      });
    })(delBtns[k]);
  }
}

function _renderSessionDropdown(container) {
  var sel = container.querySelector('#chatSessionSelect');
  if (!sel) return;
  sel.innerHTML = '';
  for (var i = 0; i < _sessions.length; i++) {
    var s = _sessions[i];
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    if (s.id === _currentId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function _renderMessages(container) {
  // 取消迟到的流式节流帧, 防止它把完整重渲后的内容覆盖回旧文本
  if (_bubbleThrottleTimer) { clearTimeout(_bubbleThrottleTimer); _bubbleThrottleTimer = null; }
  _bubblePendingArgs = null;
  var area = container.querySelector('#chatMessages');
  if (!area) return;
  var session = _currentSession();
  if (!session || !session.messages || session.messages.length === 0) {
    var role = _sessionRole(session);
    area.innerHTML = '<div class="chat-empty">当前角色: ' + role.icon + ' ' + _esc(role.name) + '<br>暂无消息，输入内容开始对话</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < session.messages.length; i++) {
    var msg = session.messages[i];
    if (msg.role === 'system') continue;
    var cls = msg.role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant';
    var bubbleContent = msg.role === 'assistant'
      ? _renderContentWithJson(msg.content || '')
      : _esc(msg.content);

    // Render user attachment thumbnails inside bubble
    var attachHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
      attachHtml = '<div class="chat-msg-attachments">';
      for (var a = 0; a < msg.attachments.length; a++) {
        var attData = msg.attachments[a].data || '';
        if (attData.length > ATTACH_PLACEHOLDER_B64) {
          // 超大老图不直接上 DOM(macOS 内存红线), 等后台瘦身完成后重绘成缩略图
          attachHtml += '<div class="chat-msg-attach-thumb" style="display:flex;align-items:center;justify-content:center;min-width:72px;min-height:56px;background:rgba(255,255,255,0.06);border-radius:4px;font-size:11px;color:#999;">🖼 处理中…</div>';
        } else {
          attachHtml += '<img class="chat-msg-attach-thumb" src="data:' + _sniffMime(attData) + ';base64,' + attData + '">';
        }
      }
      attachHtml += '</div>';
    }

    // 每条消息的操作按钮:assistant 显示复制/填入/重新生成;user 显示重新生成(使用当前回复)
    var actionsHtml = '';
    if (msg.role === 'assistant' && msg.content) {
      actionsHtml = '<div class="chat-msg-actions">' +
        '<button class="chat-msg-action-btn" data-msgact="copy" data-msgidx="' + i + '" title="复制回复">📋 复制</button>' +
        '<button class="chat-msg-action-btn" data-msgact="fill" data-msgidx="' + i + '" title="填入提示词">📝 填入提示词</button>' +
        '<button class="chat-msg-action-btn" data-msgact="regen" data-msgidx="' + i + '" title="重新生成此回复">🔄 重新生成</button>' +
      '</div>';
    }

    html += '<div class="chat-msg ' + cls + '">' +
      '<div class="chat-bubble">' + attachHtml + bubbleContent + '</div>' +
      actionsHtml +
    '</div>';
  }
  area.innerHTML = html;
  area.scrollTop = area.scrollHeight;

  // Bind all message + JSON + code events
  _bindJsonEvents(area);
}

function _bindJsonEvents(area) {
  // JSON 块内的操作 (data-jsonact: copy|fill)
  var jsonBtns = area.querySelectorAll('[data-jsonact]');
  for (var i = 0; i < jsonBtns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var act = btn.getAttribute('data-jsonact');
        var card = btn.closest('.chat-json-card');
        if (!card) return;
        var raw = card.getAttribute('data-json-raw') || '';
        var jsonStr = '';
        try { jsonStr = decodeURIComponent(raw); } catch(_) { jsonStr = ''; }
        if (!jsonStr) return;
        if (act === 'copy') {
          _copyToClipboard(jsonStr, 'JSON 已复制');
          _flashBtn(btn, '✅');
        } else if (act === 'fill') {
          // 填入提示词 textarea
          _fillToPrompt(jsonStr);
          _flashBtn(btn, '✅');
        }
      });
    })(jsonBtns[i]);
  }
  // 代码块复制 (data-codeact: copy)
  var codeBtns = area.querySelectorAll('[data-codeact="copy"]');
  for (var j = 0; j < codeBtns.length; j++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var block = btn.closest('.chat-code-block');
        if (!block) return;
        var raw = block.getAttribute('data-code-raw') || '';
        var code = '';
        try { code = decodeURIComponent(raw); } catch(_) { code = ''; }
        if (!code) return;
        _copyToClipboard(code, '代码已复制');
        _flashBtn(btn, '✅');
      });
    })(codeBtns[j]);
  }
  // 消息级操作 (复制 / 重新生成 / 填入提示词)
  var msgBtns = area.querySelectorAll('[data-msgact]');
  for (var k = 0; k < msgBtns.length; k++) {
    (function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var act = btn.getAttribute('data-msgact');
        var idx = parseInt(btn.getAttribute('data-msgidx'), 10);
        var session = _currentSession();
        if (!session || isNaN(idx) || !session.messages[idx]) return;
        var msg = session.messages[idx];
        var text = typeof msg.content === 'string' ? msg.content : '';
        if (act === 'copy') {
          _copyToClipboard(text, '已复制');
          _flashBtn(btn, '✅');
        } else if (act === 'fill') {
          _fillToPrompt(text);
          _flashBtn(btn, '✅');
        } else if (act === 'regen') {
          _regenerateFromIndex(idx);
        }
      });
    })(msgBtns[k]);
  }
}

function _copyToClipboard(text, toastMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      if (toastMsg) TileAPI.toast(toastMsg, 'success');
    }).catch(function() {
      _copyFallback(text, toastMsg);
    });
  } else {
    _copyFallback(text, toastMsg);
  }
}
function _copyFallback(text, toastMsg) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (toastMsg) TileAPI.toast(toastMsg, 'success');
  } catch(e) {
    TileAPI.toast('复制失败', 'error');
  }
}

function _flashBtn(btn, tempText) {
  var orig = btn.textContent;
  btn.textContent = tempText;
  setTimeout(function() { btn.textContent = orig; }, 1500);
}

// 把内容填入提示词磁贴
function _fillToPrompt(text) {
  if (!text) return;
  TileAPI.state.set('prompt.text', text);
  TileAPI.storage.set('prompt.lastText', text);
  TileAPI.emit('prompt:changed', { text: text, source: 'chat' });
  TileAPI.toast('已填入提示词', 'success');
}

// 从某条消息索引重新生成(清掉该消息及之后的 assistant 回复,重新发)
function _regenerateFromIndex(idx) {
  var session = _currentSession();
  if (!session || !_activeContainer) return;
  if (_generating) { TileAPI.toast('正在生成中,请先停止', 'info'); return; }
  // idx 可能是 user 也可能是 assistant 消息
  // 如果是 assistant → 从这条开始删除
  // 如果是 user → 删掉下一条 assistant(若有)
  var msg = session.messages[idx];
  if (!msg) return;
  if (msg.role === 'assistant') {
    session.messages.splice(idx, 1);
  } else if (msg.role === 'user' && session.messages[idx + 1] && session.messages[idx + 1].role === 'assistant') {
    session.messages.splice(idx + 1, 1);
  } else {
    return;  // 没有可重新生成的 assistant 回复
  }
  _renderMessages(_activeContainer);
  // 构造 API 消息并继续流式
  session.messages.push({ role: 'assistant', content: '', time: _now() });
  var apiMessages = _buildApiMessages(session);
  var assistantIdx = session.messages.length - 1;
  _setGeneratingUI(_activeContainer, true);
  _sendToApi(apiMessages,
    function onChunk(chunk) {
      session.messages[assistantIdx].content += chunk;
      _updateLastAssistantBubble(_activeContainer, session.messages[assistantIdx].content);
    },
    function onDone() {
      _setGeneratingUI(_activeContainer, false);
      _abortController = null;
      if (!session.messages[assistantIdx].content) session.messages.splice(assistantIdx, 1);
      session.updatedAt = _now();
      _scheduleSave();
      _renderMessages(_activeContainer);
    },
    function onError(m) {
      _setGeneratingUI(_activeContainer, false);
      _abortController = null;
      session.messages[assistantIdx].content = '❌ 生成错误: ' + m;
      _renderMessages(_activeContainer);
    }
  );
}

// 流式气泡节流 (2026-07-04 性能优化): 原来每来一小段字就整泡重解析+重渲,
// 长回复末尾每秒可达几十次; 压到最多 10 次/秒, 肉眼无差, CPU 大降。
// 尾包由 pending 定时器补画, 内容不丢; 完整重渲(_renderMessages)会取消迟到帧防覆盖。
var BUBBLE_PAINT_MS = 100;
var _bubbleThrottleTimer = null;
var _bubbleLastPaintAt = 0;
var _bubblePendingArgs = null;

function _updateLastAssistantBubble(container, content) {
  _bubblePendingArgs = [container, content];
  var now = Date.now();
  if (now - _bubbleLastPaintAt >= BUBBLE_PAINT_MS) {
    _bubbleLastPaintAt = now;
    _paintLastAssistantBubble();
  } else if (!_bubbleThrottleTimer) {
    _bubbleThrottleTimer = setTimeout(function() {
      _bubbleThrottleTimer = null;
      _bubbleLastPaintAt = Date.now();
      _paintLastAssistantBubble();
    }, BUBBLE_PAINT_MS - (now - _bubbleLastPaintAt));
  }
}

function _paintLastAssistantBubble() {
  if (!_bubblePendingArgs) return;
  var container = _bubblePendingArgs[0];
  var content = _bubblePendingArgs[1];
  _bubblePendingArgs = null;
  var area = container.querySelector('#chatMessages');
  if (!area) return;
  var bubbles = area.querySelectorAll('.chat-msg-assistant .chat-bubble');
  if (bubbles.length > 0) {
    var lastBubble = bubbles[bubbles.length - 1];
    lastBubble.innerHTML = _renderContentWithJson(content || '');
    _bindJsonEvents(area);
    area.scrollTop = area.scrollHeight;
  }
}

function _setGeneratingUI(container, gen) {
  _generating = gen;
  var sendBtn = container.querySelector('#chatSendBtn');
  var stopBtn = container.querySelector('#chatStopBtn');
  if (sendBtn) sendBtn.style.display = gen ? 'none' : '';
  if (stopBtn) stopBtn.style.display = gen ? '' : 'none';
}

// ── 角色卡片 & 选择器 ──

function _renderRoleCard(container) {
  var cardEl = container.querySelector('#chatRoleCard');
  if (!cardEl) return;
  var session = _currentSession();
  var role = _sessionRole(session);
  cardEl.innerHTML = '<span class="chat-role-card-icon">' + role.icon + '</span>' +
    '<span class="chat-role-card-name">' + _esc(role.name) + '</span>';
}

function _renderRoleBtnNarrow(container) {
  var btn = container.querySelector('#chatRoleBtn');
  if (!btn) return;
  var session = _currentSession();
  var role = _sessionRole(session);
  btn.textContent = role.icon;
  btn.title = '当前角色: ' + role.name;
}

function _showRoleSelector(container) {
  var all = _allRoles();
  var session = _currentSession();
  var currentRoleId = session ? (session.roleId || BUILTIN_ROLES[0].id) : BUILTIN_ROLES[0].id;

  var html = '<div class="chat-role-selector">' +
    '<div class="chat-role-selector-title">选择角色</div>' +
    '<div class="chat-role-grid">';

  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    var activeCls = r.id === currentRoleId ? ' chat-role-item-active' : '';
    var badge = i < BUILTIN_ROLES.length ? '' : '<span class="chat-role-badge">自定义</span>';
    html += '<div class="chat-role-item' + activeCls + '" data-roleid="' + _esc(r.id) + '">' +
      '<div class="chat-role-item-icon">' + r.icon + '</div>' +
      '<div class="chat-role-item-name">' + _esc(r.name) + badge + '</div>' +
      '<div class="chat-role-item-desc">' + _esc(r.description || '') + '</div>' +
    '</div>';
  }

  html += '</div>' +
    '<div class="chat-role-selector-footer">' +
      '<button class="w10-btn w10-btn-accent" id="chatRoleAddBtn">+ 自定义角色</button>' +
      '<button class="w10-btn" id="chatRoleMgrBtn">管理自定义</button>' +
    '</div>' +
  '</div>';

  TileAPI.dialog({
    title: '切换角色',
    html: html,
    buttons: ['关闭'],
    wide: true
  }).then(function() {});

  // Defer binding to next tick so dialog DOM is ready
  setTimeout(function() {
    var roleItems = document.querySelectorAll('.chat-role-item');
    for (var j = 0; j < roleItems.length; j++) {
      (function(item) {
        item.addEventListener('click', function() {
          var newId = item.getAttribute('data-roleid');
          if (newId === currentRoleId) return;

          var sess = _currentSession();
          var hasMessages = sess && sess.messages && sess.messages.length > 0;

          function doSwitch() {
            if (sess) {
              sess.roleId = newId;
              sess.updatedAt = _now();
            }
            _scheduleSave();
            _renderAll(container);
            TileAPI.toast('角色已切换', 'success');
            // Close dialog by clicking overlay
            var overlay = document.querySelector(".uik-dlg-overlay");
            if (overlay) overlay.click();
          }

          if (hasMessages) {
            TileAPI.confirm('切换角色会开启新上下文，继续?').then(function(ok) {
              if (!ok) return;
              // Start new session with the new role
              var newSess = _createSession();
              newSess.roleId = newId;
              _renderAll(container);
              _scheduleSave();
              TileAPI.toast('角色已切换，新对话已创建', 'success');
              var overlay = document.querySelector(".uik-dlg-overlay");
              if (overlay) overlay.click();
            });
          } else {
            doSwitch();
          }
        });
      })(roleItems[j]);
    }

    // Add custom role
    var addBtn = document.querySelector('#chatRoleAddBtn');
    if (addBtn) addBtn.addEventListener('click', function() {
      var overlay = document.querySelector('.uik-dlg-overlay');
      if (overlay) overlay.click();
      _showRoleEditor(container, null);
    });

    // Manage custom roles
    var mgrBtn = document.querySelector('#chatRoleMgrBtn');
    if (mgrBtn) mgrBtn.addEventListener('click', function() {
      var overlay = document.querySelector('.uik-dlg-overlay');
      if (overlay) overlay.click();
      _showRoleManager(container);
    });
  }, 50);
}

function _showRoleEditor(container, editRole) {
  var isEdit = !!editRole;
  var html = '<div class="chat-role-editor">' +
    '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">图标 (emoji)</div></div>' +
      '<div class="w10-row-right"><input class="w10-input" id="chatRoleEditIcon" value="' + _esc(editRole ? editRole.icon : '\uD83E\uDD16') + '" style="width:60px;text-align:center;"></div></div>' +
    '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">名称</div></div>' +
      '<div class="w10-row-right"><input class="w10-input" id="chatRoleEditName" value="' + _esc(editRole ? editRole.name : '') + '" placeholder="角色名称"></div></div>' +
    '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">描述</div></div>' +
      '<div class="w10-row-right"><input class="w10-input" id="chatRoleEditDesc" value="' + _esc(editRole ? editRole.description : '') + '" placeholder="简短描述"></div></div>' +
    '<div style="margin-top:8px;">' +
      '<div class="w10-row-label" style="margin-bottom:4px;">系统提示词</div>' +
      '<textarea class="w10-input" id="chatRoleEditPrompt" rows="6" style="width:100%;resize:vertical;">' + _esc(editRole ? editRole.systemPrompt : '') + '</textarea>' +
    '</div>' +
  '</div>';

  TileAPI.dialog({
    title: isEdit ? '编辑角色' : '新建角色',
    html: html,
    buttons: ['取消', '保存'],
    accent: 1
  }).then(function(res) {
    if (!res || res.index !== 1) return;
    var icon = document.querySelector('#chatRoleEditIcon');
    var name = document.querySelector('#chatRoleEditName');
    var desc = document.querySelector('#chatRoleEditDesc');
    var prompt = document.querySelector('#chatRoleEditPrompt');
    if (!icon || !name || !prompt) return;

    var iconVal = icon.value.trim() || '\uD83E\uDD16';
    var nameVal = name.value.trim();
    var descVal = desc.value.trim();
    var promptVal = prompt.value.trim();

    if (!nameVal) { TileAPI.toast('名称不能为空', 'error'); return; }
    if (!promptVal) { TileAPI.toast('系统提示词不能为空', 'error'); return; }

    if (isEdit) {
      editRole.icon = iconVal;
      editRole.name = nameVal;
      editRole.description = descVal;
      editRole.systemPrompt = promptVal;
    } else {
      var newRole = {
        id: 'custom_' + _genId(),
        icon: iconVal,
        name: nameVal,
        description: descVal,
        systemPrompt: promptVal
      };
      _customRoles.push(newRole);
    }
    _saveCustomRoles();
    _renderAll(container);
    TileAPI.toast(isEdit ? '角色已更新' : '角色已创建', 'success');
    // 保存完成后自动重开角色选择器,让用户直接看到结果
    if (!isEdit) {
      setTimeout(function() { _showRoleSelector(container); }, 200);
    }
  });
}

function _showRoleManager(container) {
  if (_customRoles.length === 0) {
    TileAPI.toast('暂无自定义角色', 'info');
    return;
  }
  var html = '<div class="chat-role-manager">';
  for (var i = 0; i < _customRoles.length; i++) {
    var r = _customRoles[i];
    html += '<div class="chat-role-mgr-item" data-mgridx="' + i + '">' +
      '<span class="chat-role-mgr-icon">' + r.icon + '</span>' +
      '<span class="chat-role-mgr-name">' + _esc(r.name) + '</span>' +
      '<span class="chat-role-mgr-actions">' +
        '<button class="w10-btn chat-role-mgr-edit" data-mgridx="' + i + '">编辑</button>' +
        '<button class="w10-btn chat-role-mgr-copy" data-mgridx="' + i + '">复制</button>' +
        '<button class="w10-btn" data-mgridx="' + i + '" style="color:#ff6b6b;border-color:rgba(255,100,100,0.3)">删除</button>' +
      '</span>' +
    '</div>';
  }
  html += '</div>';

  TileAPI.dialog({
    title: '管理自定义角色',
    html: html,
    buttons: ['关闭']
  }).then(function() {});

  setTimeout(function() {
    // Edit
    var editBtns = document.querySelectorAll('.chat-role-mgr-edit');
    for (var e = 0; e < editBtns.length; e++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.getAttribute('data-mgridx'));
          var overlay = document.querySelector('.uik-dlg-overlay');
          if (overlay) overlay.click();
          if (_customRoles[idx]) _showRoleEditor(container, _customRoles[idx]);
        });
      })(editBtns[e]);
    }
    // Copy
    var copyBtns = document.querySelectorAll('.chat-role-mgr-copy');
    for (var c = 0; c < copyBtns.length; c++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.getAttribute('data-mgridx'));
          if (_customRoles[idx]) {
            var src = _customRoles[idx];
            _customRoles.push({
              id: 'custom_' + _genId(),
              icon: src.icon,
              name: src.name + ' (副本)',
              description: src.description,
              systemPrompt: src.systemPrompt
            });
            _saveCustomRoles();
            TileAPI.toast('角色已复制', 'success');
            var overlay = document.querySelector('.uik-dlg-overlay');
            if (overlay) overlay.click();
            _showRoleManager(container);
          }
        });
      })(copyBtns[c]);
    }
    // Delete
    var delBtns = document.querySelectorAll('.chat-role-mgr-item [style*="ff6b6b"]');
    for (var d = 0; d < delBtns.length; d++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var idx = parseInt(btn.getAttribute('data-mgridx'));
          TileAPI.confirm('确定删除该角色?').then(function(ok) {
            if (!ok) return;
            _customRoles.splice(idx, 1);
            _saveCustomRoles();
            TileAPI.toast('角色已删除', 'info');
            var overlay = document.querySelector('.uik-dlg-overlay');
            if (overlay) overlay.click();
            _renderAll(container);
          });
        });
      })(delBtns[d]);
    }
  }, 50);
}

// ── 聊天设置面板 ──
function _showChatSettings(container) {
  var chatUrl = TileAPI.storage.get('chat.url') || '';
  var chatKey = TileAPI.storage.get('chat.key') || '';
  var chatModel = TileAPI.storage.get('chat.model') || '';
  var maxTokens = _getMaxTokens();
  var temperature = _getTemperature();
  var chatMaxRes = TileAPI.storage.get('chat.maxResolution') || 1024;

  // 从 state 读取之前拉取过的模型列表(缓存,避免每次打开设置都要重拉)
  var cachedModels = TileAPI.state.get('chat.fetchedModels') || [];

  // 自定义下拉(避免原生 select 在 UXP dialog 里被底部压住的 z-index 问题)
  var modelListHtml = '';
  for (var mi = 0; mi < cachedModels.length; mi++) {
    var m = cachedModels[mi];
    modelListHtml += '<div class="chat-cfg-model-opt' + (m === chatModel ? ' chat-cfg-model-opt-active' : '') + '" data-modelval="' + _esc(m) + '">' + _esc(m) + '</div>';
  }
  if (!modelListHtml) {
    modelListHtml = '<div class="chat-cfg-model-empty">暂无缓存,点右侧"拉取"获取模型列表</div>';
  }

  var html =
    '<div class="chat-settings">' +
      '<div class="w10-section-title">API 配置</div>' +

      '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
        '<div class="w10-row-label">API URL</div>' +
        '<input class="w10-input" id="chatCfgUrl" value="' + _esc(chatUrl) + '" placeholder="' + _esc(DEFAULT_URL) + '">' +
      '</div>' +

      '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
        '<div class="w10-row-label">API Key</div>' +
        '<input class="w10-input" id="chatCfgKey" type="password" value="' + _esc(chatKey) + '" placeholder="sk-...">' +
      '</div>' +

      '<div class="w10-row" style="flex-direction:column;align-items:stretch;">' +
        '<div class="w10-row-label">模型</div>' +
        '<div class="chat-cfg-model-row">' +
          '<div class="chat-cfg-model-dropdown" id="chatCfgModelDropdown">' +
            '<button type="button" class="chat-cfg-model-dropdown-btn" id="chatCfgModelDropdownBtn" title="已缓存 ' + cachedModels.length + ' 个模型">' +
              '<span>📋 已缓存 (' + cachedModels.length + ')</span>' +
              '<span class="chat-cfg-model-dropdown-arrow">▾</span>' +
            '</button>' +
            '<div class="chat-cfg-model-dropdown-panel" id="chatCfgModelDropdownPanel" style="display:none;">' + modelListHtml + '</div>' +
          '</div>' +
          '<input class="w10-input chat-cfg-model-input" id="chatCfgModel" value="' + _esc(chatModel) + '" placeholder="' + _esc(DEFAULT_MODEL) + '">' +
          '<button class="w10-btn chat-cfg-fetch-btn" id="chatCfgFetchBtn" title="从 API 拉取可用模型列表">🔄 拉取</button>' +
        '</div>' +
        '<div class="w10-row-desc" id="chatCfgFetchStatus" style="margin-top:4px;min-height:14px;"></div>' +
      '</div>' +

      '<div class="w10-section-title">生成参数</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">max_tokens</div>' +
          '<div class="w10-row-desc">单次回复的最大 token 数(256-131072)</div>' +
        '</div>' +
        '<div class="w10-row-right">' +
          '<input class="w10-input" id="chatCfgMaxTokens" type="number" min="256" max="131072" step="256" value="' + maxTokens + '" style="width:100px;">' +
        '</div>' +
      '</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">temperature</div>' +
          '<div class="w10-row-desc">0=确定性,1=平衡,2=创造性</div>' +
        '</div>' +
        '<div class="w10-row-right" style="display:flex;align-items:center;gap:8px;">' +
          '<input type="range" id="chatCfgTemperature" min="0" max="2" step="0.1" value="' + temperature + '" style="width:120px;">' +
          '<span id="chatCfgTemperatureVal" style="min-width:30px;font-variant-numeric:tabular-nums;">' + temperature.toFixed(1) + '</span>' +
        '</div>' +
      '</div>' +

      '<div class="w10-section-title">图片</div>' +
      '<div class="w10-row">' +
        '<div class="w10-row-left">' +
          '<div class="w10-row-label">图片分辨率</div>' +
          '<div class="w10-row-desc">从 PS 截取图片的最大边长(px)</div>' +
        '</div>' +
        '<div class="w10-row-right" style="display:flex;align-items:center;gap:8px;">' +
          '<input type="range" id="chatCfgMaxRes" min="256" max="4096" step="64" value="' + chatMaxRes + '" style="width:120px;">' +
          '<span id="chatCfgMaxResVal" style="min-width:40px;font-variant-numeric:tabular-nums;">' + chatMaxRes + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  TileAPI.dialog({
    title: '⚙️ 聊天设置',
    html: html,
    buttons: ['取消', '保存'],
    accent: 1
  }).then(function(res) {
    if (!res || res.index !== 1) return;
    var url = document.querySelector('#chatCfgUrl');
    var key = document.querySelector('#chatCfgKey');
    var model = document.querySelector('#chatCfgModel');
    var mt = document.querySelector('#chatCfgMaxTokens');
    var tp = document.querySelector('#chatCfgTemperature');

    if (url) TileAPI.storage.set('chat.url', url.value.trim());
    if (key) TileAPI.storage.set('chat.key', key.value.replace(/\s+/g, ''));
    if (model) TileAPI.storage.set('chat.model', model.value.trim());
    if (mt) {
      var mtVal = parseInt(mt.value, 10);
      if (mtVal > 0) TileAPI.storage.set('chat.maxTokens', mtVal);
    }
    if (tp) {
      var tpVal = parseFloat(tp.value);
      if (tpVal >= 0 && tpVal <= 2) TileAPI.storage.set('chat.temperature', tpVal);
    }
    var maxRes = document.querySelector('#chatCfgMaxRes');
    if (maxRes) {
      var mrVal = parseInt(maxRes.value, 10);
      if (mrVal >= 256) {
        TileAPI.storage.set('chat.maxResolution', mrVal);
        TileAPI.sendToHost('chatSettingsUpdated', { chatMaxResolution: mrVal });
      }
    }
    TileAPI.toast('聊天设置已保存', 'success');
  });

  // 对话框打开后:绑定交互
  setTimeout(function() {
    var ddBtn = document.querySelector('#chatCfgModelDropdownBtn');
    var ddPanel = document.querySelector('#chatCfgModelDropdownPanel');
    var fetchBtn = document.querySelector('#chatCfgFetchBtn');
    var fetchStatus = document.querySelector('#chatCfgFetchStatus');
    var modelInp = document.querySelector('#chatCfgModel');

    // 自定义下拉:点按钮切换面板,点选项填入输入框
    if (ddBtn && ddPanel) {
      ddBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var open = ddPanel.style.display !== 'none';
        ddPanel.style.display = open ? 'none' : 'block';
        var arrow = ddBtn.querySelector('.chat-cfg-model-dropdown-arrow');
        if (arrow) arrow.textContent = open ? '▾' : '▴';
      });
      // 点面板里的选项
      ddPanel.addEventListener('click', function(e) {
        var opt = e.target.closest('[data-modelval]');
        if (!opt) return;
        var v = opt.getAttribute('data-modelval') || '';
        if (modelInp) modelInp.value = v;
        // 视觉高亮
        var actives = ddPanel.querySelectorAll('.chat-cfg-model-opt-active');
        for (var ai = 0; ai < actives.length; ai++) actives[ai].classList.remove('chat-cfg-model-opt-active');
        opt.classList.add('chat-cfg-model-opt-active');
        // 关闭面板
        ddPanel.style.display = 'none';
        var arrow = ddBtn.querySelector('.chat-cfg-model-dropdown-arrow');
        if (arrow) arrow.textContent = '▾';
      });
      // 点外部关闭面板 (弹窗关闭后 ddPanel 会离开 DOM → 自注销, 避免每开一次设置叠一个 document 监听 · bug #10 同款)
      var _onOutside = function(e) {
        if (!ddPanel || !ddPanel.isConnected) {
          document.removeEventListener('click', _onOutside, true);
          return;
        }
        if (!ddPanel.contains(e.target) && !ddBtn.contains(e.target)) {
          ddPanel.style.display = 'none';
          var arrow = ddBtn.querySelector('.chat-cfg-model-dropdown-arrow');
          if (arrow) arrow.textContent = '▾';
        }
      };
      document.addEventListener('click', _onOutside, true);
    }

    // Temperature 滑块实时显示
    var tp = document.querySelector('#chatCfgTemperature');
    var tpVal = document.querySelector('#chatCfgTemperatureVal');
    if (tp && tpVal) {
      tp.addEventListener('input', function() {
        tpVal.textContent = parseFloat(tp.value).toFixed(1);
      });
    }

    // 图片分辨率滑块实时显示
    var maxRes = document.querySelector('#chatCfgMaxRes');
    var maxResVal = document.querySelector('#chatCfgMaxResVal');
    if (maxRes && maxResVal) {
      maxRes.addEventListener('input', function() {
        maxResVal.textContent = maxRes.value;
      });
    }

    // 拉取模型列表
    if (fetchBtn) fetchBtn.addEventListener('click', async function() {
      // 拉取用的 URL/Key:输入框优先,留空时用 storage 里已保存的值
      var urlInp = document.querySelector('#chatCfgUrl');
      var keyInp = document.querySelector('#chatCfgKey');
      var modelInp = document.querySelector('#chatCfgModel');
      var pullUrl = (urlInp && urlInp.value.trim()) || TileAPI.storage.get('chat.url') || DEFAULT_URL;
      var pullKey = (keyInp && keyInp.value.replace(/\s+/g, '')) || TileAPI.storage.get('chat.key') || '';
      if (!pullUrl) {
        if (fetchStatus) { fetchStatus.textContent = '❌ 请先填写 API URL'; fetchStatus.style.color = '#ff6b6b'; }
        return;
      }
      if (!pullKey) {
        if (fetchStatus) { fetchStatus.textContent = '❌ 请先填写 API Key'; fetchStatus.style.color = '#ff6b6b'; }
        return;
      }
      // URL 处理:去掉末尾 / 和 chat/completions 路径,得到 base
      var baseUrl = pullUrl.replace(/\/$/, '').replace(/\/chat\/completions$/i, '');
      var origText = fetchBtn.textContent;
      fetchBtn.textContent = '⏳ 拉取中';
      fetchBtn.disabled = true;
      if (fetchStatus) { fetchStatus.textContent = '正在拉取模型列表...'; fetchStatus.style.color = 'var(--text-sub)'; }

      try {
        // base 已含 /v1 → 直接 +/models;否则补 /v1/models
        var endpoint = baseUrl + (baseUrl.match(/\/v\d+$/) ? '/models' : '/v1/models');
        TileAPI.log('[chat] 拉取模型: ' + endpoint, 'info');
        var resp = await _netConfig.fetchWithTimeout(endpoint, { method: 'GET', headers: { 'Authorization': 'Bearer ' + pullKey } }, 15000);
        if (!resp.ok) {
          var errText = '';
          try { errText = await resp.text(); } catch(_) {}
          throw new Error('HTTP ' + resp.status + (errText ? ' — ' + errText.slice(0, 200) : ''));
        }
        var data = await resp.json();
        var models = [];
        if (data.data && Array.isArray(data.data)) {
          models = data.data.map(function(m) { return m.id || m.name || ''; }).filter(Boolean);
        } else if (Array.isArray(data.models)) {
          models = data.models.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name || ''); }).filter(Boolean);
        } else if (Array.isArray(data)) {
          models = data.map(function(m) { return typeof m === 'string' ? m : (m.id || m.name || ''); }).filter(Boolean);
        }
        models.sort();
        if (models.length === 0) {
          if (fetchStatus) { fetchStatus.textContent = '⚠️ API 返回成功,但没有解析到模型(响应格式未知)'; fetchStatus.style.color = '#ff9800'; }
        } else {
          // 缓存到 state,下次打开设置能直接用
          TileAPI.state.set('chat.fetchedModels', models);
          // 刷新自定义下拉面板内容
          if (ddPanel) {
            var newHtml = '';
            var curVal = modelInp ? modelInp.value : '';
            for (var i = 0; i < models.length; i++) {
              var mm = models[i];
              newHtml += '<div class="chat-cfg-model-opt' + (mm === curVal ? ' chat-cfg-model-opt-active' : '') + '" data-modelval="' + _esc(mm) + '">' + _esc(mm) + '</div>';
            }
            ddPanel.innerHTML = newHtml;
          }
          if (ddBtn) {
            var span = ddBtn.querySelector('span:first-child');
            if (span) span.textContent = '📋 已缓存 (' + models.length + ')';
            ddBtn.setAttribute('title', '已缓存 ' + models.length + ' 个模型');
          }
          if (fetchStatus) { fetchStatus.textContent = '✅ 拉取到 ' + models.length + ' 个模型,点左侧"已缓存"查看列表'; fetchStatus.style.color = '#4caf50'; }
        }
      } catch(e) {
        var msg = (e && (e.message || e.toString())) || '未知错误';
        TileAPI.log('[chat] 拉取模型失败: ' + msg, 'error');
        if (fetchStatus) { fetchStatus.textContent = '❌ 拉取失败: ' + msg; fetchStatus.style.color = '#ff6b6b'; }
      }
      fetchBtn.textContent = origText;
      fetchBtn.disabled = false;
    });
  }, 50);
}

// ── 附件 UI ──

function _renderAttachBar(container) {
  var bar = container.querySelector('#chatAttachBar');
  if (!bar) return;
  if (_pendingAttachments.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = '';
  var html = '<span class="chat-attach-label">已附加 ' + _pendingAttachments.length + ' 张图</span>';
  for (var i = 0; i < _pendingAttachments.length; i++) {
    html += '<span class="chat-attach-thumb-wrap">' +
      '<img class="chat-attach-thumb" src="data:image/png;base64,' + _pendingAttachments[i] + '">' +
      '<span class="chat-attach-del" data-attachidx="' + i + '">&times;</span>' +
    '</span>';
  }
  bar.innerHTML = html;

  var delBtns = bar.querySelectorAll('.chat-attach-del');
  for (var j = 0; j < delBtns.length; j++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var idx = parseInt(btn.getAttribute('data-attachidx'));
        _pendingAttachments.splice(idx, 1);
        _renderAttachBar(container);
      });
    })(delBtns[j]);
  }
}

function _attachFromPS(container) {
  if (_pendingAttachments.length >= MAX_ATTACHMENTS) {
    TileAPI.toast('最多附加 ' + MAX_ATTACHMENTS + ' 张图', 'error');
    return;
  }
  TileAPI.sendToHost('captureForChat', {});
  TileAPI.toast('正在从 PS 截取...', 'info');
}

function _attachFromFile(container) {
  if (_pendingAttachments.length >= MAX_ATTACHMENTS) {
    TileAPI.toast('最多附加 ' + MAX_ATTACHMENTS + ' 张图', 'error');
    return;
  }
  // UXP file picker
  try {
    var fs = require('uxp').storage;
    if (fs && fs.localFileSystem) {
      fs.localFileSystem.getFileForOpening({ types: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }).then(function(file) {
        if (!file) return;
        file.read({ format: fs.formats.binary }).then(function(buf) {
          var bytes = new Uint8Array(buf);
          var binary = '';
          for (var k = 0; k < bytes.length; k++) binary += String.fromCharCode(bytes[k]);
          var base64 = btoa(binary);
          // 文件选来的图没经过任何压缩(相机原片可能几十MB), 统一先压再进聊天
          _normalizeAttachment(base64, function(smallB64) {
            if (_pendingAttachments.length >= MAX_ATTACHMENTS) return;
            _pendingAttachments.push(smallB64);
            _renderAttachBar(container);
            TileAPI.toast('图片已附加', 'success');
          });
        });
      }).catch(function() {});
    }
  } catch(e) {
    TileAPI.toast('文件选择不可用', 'error');
  }
}

function _renderAll(container) {
  _renderSessionList(container);
  _renderSessionStrip(container);
  _renderSessionDropdown(container);
  _renderMessages(container);
  _renderRoleCard(container);
  _renderRoleBtnNarrow(container);
  _renderAttachBar(container);
}

// ── 发送消息核心逻辑 ──

function _doSend(container) {
  var input = container.querySelector('#chatInput');
  if (!input) return;
  var text = input.value.trim();
  if (!text || _generating) return;

  if (!_getKey()) {
    TileAPI.toast('请先在聊天磁贴的设置中配置 API Key', 'error');
    return;
  }

  var session = _currentSession();
  if (!session) { session = _createSession(); _renderSessionList(container); _renderSessionStrip(container); _renderSessionDropdown(container); }

  // Collect attachments
  var attachments = [];
  for (var i = 0; i < _pendingAttachments.length; i++) {
    attachments.push({ type: 'image', data: _pendingAttachments[i] });
  }
  _pendingAttachments = [];
  _renderAttachBar(container);

  // user message
  var userMsg = { role: 'user', content: text, time: _now() };
  if (attachments.length > 0) userMsg.attachments = attachments;
  session.messages.push(userMsg);

  // assistant placeholder
  session.messages.push({ role: 'assistant', content: '', time: _now() });
  session.updatedAt = _now();

  input.value = '';
  _renderMessages(container);
  _setGeneratingUI(container, true);

  // 自动命名
  if (session.messages.filter(function(m) { return m.role === 'user'; }).length === 1 && session.title === '未命名对话') {
    session.title = text.substring(0, 20) + (text.length > 20 ? '...' : '');
    _renderSessionList(container);
    _renderSessionStrip(container);
    _renderSessionDropdown(container);
  }

  var apiMessages = _buildApiMessages(session);
  var assistantIdx = session.messages.length - 1;

  _sendToApi(apiMessages,
    function onChunk(chunk) {
      session.messages[assistantIdx].content += chunk;
      _updateLastAssistantBubble(container, session.messages[assistantIdx].content);
    },
    function onDone() {
      _setGeneratingUI(container, false);
      _abortController = null;
      if (!session.messages[assistantIdx].content) {
        session.messages.splice(assistantIdx, 1);
      }
      session.updatedAt = _now();
      _renderMessages(container);  // 重绘以挂上操作按钮 (copy/fill/regen)
      _scheduleSave();
    },
    function onError(msg) {
      _setGeneratingUI(container, false);
      _abortController = null;
      session.messages[assistantIdx].content = '(错误: ' + msg + ')';
      session.updatedAt = _now();
      _renderMessages(container);  // 重绘以挂上操作按钮
      TileAPI.toast('请求失败: ' + msg, 'error');
      _scheduleSave();
    }
  );
}

// ── 5 档布局 ──

function _attachBtnsHtml() {
  return '<button class="w10-btn chat-attach-ps-btn" id="chatAttachPS" title="从 PS 截取">\uD83D\uDCF7</button>' +
    '<button class="w10-btn chat-attach-file-btn" id="chatAttachFile" title="从文件选择">\uD83D\uDCCE</button>';
}

function _renderWide(container) {
  container.innerHTML =
    '<div class="w10-panel chat-panel chat-layout-wide">' +
      '<div class="chat-top-strip">' +
        '<div class="chat-session-strip" id="chatSessionStrip"></div>' +
        '<button class="w10-btn chat-new-btn-sm" id="chatNewBtn" title="新建对话">+</button>' +
      '</div>' +
      '<div class="chat-toolbar">' +
        '<button class="w10-btn chat-role-card-btn" id="chatRoleCard" title="切换角色"></button>' +
        '<button class="w10-btn chat-clear-btn" id="chatClearBtn">清空</button>' +
        '<button class="w10-btn chat-settings-btn" id="chatSettingsBtn" title="聊天设置(API/模型/参数)">⚙️</button>' +
        '<div style="flex:1;"></div>' +
        _attachBtnsHtml() +
      '</div>' +
      '<div class="chat-attach-bar" id="chatAttachBar" style="display:none;"></div>' +
      '<div class="chat-messages" id="chatMessages"></div>' +
      '<div class="chat-input-bar">' +
        '<textarea class="w10-input chat-input" id="chatInput" placeholder="输入消息..." rows="2"></textarea>' +
        '<button class="w10-btn w10-btn-accent chat-send-btn" id="chatSendBtn">发送</button>' +
        '<button class="w10-btn chat-stop-btn" id="chatStopBtn" style="display:none;color:#ff6b6b;border-color:rgba(255,100,100,0.3)">停止</button>' +
      '</div>' +
    '</div>';
}

function _renderSquare(container) {
  container.innerHTML =
    '<div class="w10-panel chat-panel chat-layout-square">' +
      '<div class="chat-toolbar">' +
        '<button class="w10-btn w10-btn-accent chat-new-btn" id="chatNewBtn">+ 新建</button>' +
        '<button class="w10-btn chat-role-card-btn" id="chatRoleCard" title="切换角色"></button>' +
        '<button class="w10-btn chat-clear-btn" id="chatClearBtn">清空</button>' +
        '<button class="w10-btn chat-settings-btn" id="chatSettingsBtn" title="聊天设置">⚙️</button>' +
        '<div style="flex:1;"></div>' +
        _attachBtnsHtml() +
      '</div>' +
      '<div class="chat-attach-bar" id="chatAttachBar" style="display:none;"></div>' +
      '<div class="chat-messages" id="chatMessages"></div>' +
      '<div class="chat-input-bar">' +
        '<textarea class="w10-input chat-input" id="chatInput" placeholder="输入消息..." rows="2"></textarea>' +
        '<button class="w10-btn w10-btn-accent chat-send-btn" id="chatSendBtn">发送</button>' +
        '<button class="w10-btn chat-stop-btn" id="chatStopBtn" style="display:none;color:#ff6b6b;border-color:rgba(255,100,100,0.3)">停止</button>' +
      '</div>' +
    '</div>';
}

function _renderNarrowTall(container) {
  container.innerHTML =
    '<div class="w10-panel chat-panel chat-layout-narrow">' +
      '<div class="chat-toolbar">' +
        '<select class="w10-select chat-session-select" id="chatSessionSelect"></select>' +
        '<button class="w10-btn w10-btn-accent chat-new-btn chat-new-btn-sm" id="chatNewBtn">+</button>' +
        '<button class="w10-btn chat-role-btn-narrow" id="chatRoleBtn" title="切换角色">\uD83C\uDFA8</button>' +
        '<button class="w10-btn chat-clear-btn" id="chatClearBtn">清空</button>' +
        _attachBtnsHtml() +
      '</div>' +
      '<div class="chat-attach-bar" id="chatAttachBar" style="display:none;"></div>' +
      '<div class="chat-messages" id="chatMessages"></div>' +
      '<div class="chat-input-bar">' +
        '<textarea class="w10-input chat-input" id="chatInput" placeholder="输入消息..." rows="1"></textarea>' +
        '<button class="w10-btn w10-btn-accent chat-send-btn" id="chatSendBtn">发送</button>' +
        '<button class="w10-btn chat-stop-btn" id="chatStopBtn" style="display:none;color:#ff6b6b;border-color:rgba(255,100,100,0.3)">停止</button>' +
      '</div>' +
    '</div>';
}

function _renderWideShort(container) {
  container.innerHTML =
    '<div class="w10-panel chat-panel chat-layout-wideshort">' +
      '<div class="chat-wideshort-left">' +
        '<button class="w10-btn chat-role-btn-narrow" id="chatRoleBtn" title="切换角色">🎨</button>' +
        '<textarea class="w10-input chat-input" id="chatInput" placeholder="输入消息..." rows="1"></textarea>' +
        _attachBtnsHtml() +
        '<button class="w10-btn w10-btn-accent chat-send-btn" id="chatSendBtn">发送</button>' +
        '<button class="w10-btn chat-stop-btn" id="chatStopBtn" style="display:none;color:#ff6b6b;border-color:rgba(255,100,100,0.3)">停止</button>' +
      '</div>' +
      '<div class="chat-wideshort-right">' +
        '<div class="chat-messages chat-messages-compact" id="chatMessages"></div>' +
      '</div>' +
    '</div>';
}

// ── 事件绑定 ──

function _bindEvents(container) {
  // 新建
  var newBtn = container.querySelector('#chatNewBtn');
  if (newBtn) newBtn.addEventListener('click', function() {
    _createSession();
    _pendingAttachments = [];
    _renderAll(container);
    _scheduleSave();
  });

  // 清空
  var clearBtn = container.querySelector('#chatClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    TileAPI.confirm('确定清空当前对话的所有消息?').then(function(ok) {
      if (!ok) return;
      var session = _currentSession();
      if (session) {
        session.messages = [];
        session.updatedAt = _now();
      }
      _renderMessages(container);
      _scheduleSave();
      TileAPI.toast('对话已清空', 'info');
    });
  });

  // 聊天设置按钮
  var settingsBtn = container.querySelector('#chatSettingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', function() {
    _showChatSettings(container);
  });

  // 发送
  var sendBtn = container.querySelector('#chatSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', function() { _doSend(container); });

  // 停止
  var stopBtn = container.querySelector('#chatStopBtn');
  if (stopBtn) stopBtn.addEventListener('click', function() {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    _setGeneratingUI(container, false);
    TileAPI.toast('已停止生成', 'info');
  });

  // Enter 发送 / Shift+Enter 换行
  var inputEl = container.querySelector('#chatInput');
  if (inputEl) inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _doSend(container);
    }
  });

  // 会话下拉切换(narrow/tall)
  var sessionSel = container.querySelector('#chatSessionSelect');
  if (sessionSel) sessionSel.addEventListener('change', function() {
    var sid = sessionSel.value;
    if (sid && sid !== _currentId) {
      _currentId = sid;
      _pendingAttachments = [];
      _renderMessages(container);
      _renderSessionList(container);
      _renderSessionStrip(container);
      _renderRoleCard(container);
      _renderRoleBtnNarrow(container);
      _renderAttachBar(container);
      _scheduleSave();
    }
  });

  // 角色卡片点击 (wide布局)
  var roleCard = container.querySelector('#chatRoleCard');
  if (roleCard) roleCard.addEventListener('click', function() {
    _showRoleSelector(container);
  });

  // 角色按钮 (narrow布局)
  var roleBtn = container.querySelector('#chatRoleBtn');
  if (roleBtn) roleBtn.addEventListener('click', function() {
    _showRoleSelector(container);
  });

  // 附件: 从PS截取
  var attachPS = container.querySelector('#chatAttachPS');
  if (attachPS) attachPS.addEventListener('click', function() {
    _attachFromPS(container);
  });

  // 附件: 从文件选择
  var attachFile = container.querySelector('#chatAttachFile');
  if (attachFile) attachFile.addEventListener('click', function() {
    _attachFromFile(container);
  });
}

// ── 磁贴注册 ──

TileAPI.registerTile({
  id: 'chat',
  group: 'main',
  icon: '\uD83D\uDCAC',
  label: 'AI 助手',
  desc: '对话式助手',
  live: false,
  defaultSize: { w: 2, h: 3 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w, h) {
    if (_generating) {
      container.innerHTML = '<div class="tile-icon">\uD83D\uDCAC</div><div class="tile-label">生成中...</div>';
    } else if (w >= 2) {
      container.innerHTML = '<div class="tile-icon">\uD83D\uDCAC</div><div class="tile-label">AI 助手</div><div class="tile-desc">对话式助手</div>';
    } else {
      container.innerHTML = '<div class="tile-icon">\uD83D\uDCAC</div><div class="tile-label">AI 助手</div>';
    }
  },

  onExpand: function(container, sizeHint) {
    var layout = (sizeHint && sizeHint.layout) || 'wide';
    _activeContainer = container;

    // 加载自定义角色
    _loadCustomRoles();

    // 窄/高布局一律用 square 渲染(单列竖排,内容全),避免精简版藏掉设置按钮
    if (layout === 'narrow' || layout === 'tall') layout = 'square';

    // 渲染布局
    if (layout === 'wide') {
      _renderWide(container);
    } else if (layout === 'wideshort') {
      _renderWideShort(container);
    } else if (layout === 'square') {
      _renderSquare(container);
    } else {
      _renderNarrowTall(container);
    }

    // 加载数据
    _loadData(function() {
      if (_sessions.length === 0) _createSession();
      _renderAll(container);
    });
    // 如果数据已在内存中
    if (_sessions.length > 0) {
      _renderAll(container);
    }

    _bindEvents(container);

    // 打开后稍等一拍, 后台把历史聊天里的大图压小(修 macOS 黑屏/Windows OOM)
    setTimeout(_migrateHeavyAttachments, 800);

    // 若内置角色刚在启动时加载(可能落后于磁贴 onExpand),加载完成后刷新一次
    var onRolesLoaded = function() {
      if (_activeContainer === container) _renderAll(container);
    };
    TileAPI.on('chat:builtinRolesLoaded', onRolesLoaded);

    return function() {
      _activeContainer = null;
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; _doSave(); }
      TileAPI.off('chat:builtinRolesLoaded', onRolesLoaded);
    };
  },

  onMessage: function(action, data) {
    // 会话数据加载
    if (action === 'chatDataLoaded' && data) {
      if (data.type === 'sessions' && data.data) {
        var loaded = data.data;
        if (loaded.sessions && loaded.sessions.length > 0) {
          _sessions = loaded.sessions;
          _currentId = loaded.currentId || (_sessions[0] && _sessions[0].id) || null;
        } else if (Array.isArray(loaded) && loaded.length > 0) {
          _sessions = loaded;
          _currentId = _sessions[0] && _sessions[0].id;
        }
        if (_sessions.length === 0) _createSession();
        if (_activeContainer) _renderAll(_activeContainer);
        TileAPI.storage.set('chat.sessions', { sessions: _sessions, currentId: _currentId });
        // 从文件加载回来的老记录同样要瘦身
        setTimeout(_migrateHeavyAttachments, 800);
      }
    }

    // PS截图结果
    if (action === 'captureForChatResult' && data) {
      if (data.success && data.base64) {
        if (_pendingAttachments.length < MAX_ATTACHMENTS) {
          _normalizeAttachment(data.base64, function(smallB64) {
            if (_pendingAttachments.length >= MAX_ATTACHMENTS) return;
            _pendingAttachments.push(smallB64);
            if (_activeContainer) _renderAttachBar(_activeContainer);
            TileAPI.toast('截图已附加', 'success');
          });
        }
      } else {
        TileAPI.toast('截图失败: ' + (data.error || '未知错误'), 'error');
      }
    }
  },

  onStorageLoaded: function(storage) {
    var stored = storage.get('chat.sessions');
    if (stored && stored.sessions) {
      _sessions = stored.sessions;
      _currentId = stored.currentId || (_sessions[0] && _sessions[0].id) || null;
    }
    var roles = storage.get('chat.customRoles');
    if (roles && Array.isArray(roles)) _customRoles = roles;
  }
});

document.addEventListener('click', function(e) {
  var btn = e.target.closest('.key-eye-btn-chat');
  if (!btn) return;
  var targetId = btn.dataset.target;
  var inp = document.getElementById(targetId);
  if (!inp) return;
  var isPw = inp.type === 'password';
  inp.type = isPw ? 'text' : 'password';
  btn.textContent = isPw ? '👀' : '👁';
});
})();
