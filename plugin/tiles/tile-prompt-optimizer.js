// ============================================================
//  tile-prompt-optimizer.js — 提示词优化磁贴
//  视觉对齐 tile-prompt:w10-panel.prompt-ta-panel + prompt-preset-head + prompt-ta
//
//  设计要点:
//  - 标题写死"优化"(两字),顶栏永远单行不抖动
//  - 优化中: textarea 冻结(readOnly) 显示进度文字,操作按钮全部禁用
//  - 优化完成: textarea 切回结果,恢复可编辑
//  - placeholder 在静止期承担帮助说明角色
// ============================================================
(function() {
'use strict';

var _activeContainer = null;
var _optimizing = false;
// 多轮对话:[{role,content}, ...]
//   首次成功后:[user(原始), assistant(结果)]
//   二次优化后:[user(原始), assistant(上次), user(意见), assistant(本次)]
var _convo = [];
// 折叠/展开未优化时的草稿
var _draft = '';
// 优化前主框/二次意见框的内容快照(为了取消/失败时还原)
var _frozenMainText = '';
var _frozenFollowupText = '';

var PROGRESS_MSG =
  '⏳ 正在调用 AI 优化,请稍候…\n\n' +
  '当前使用 deepseek-v4-pro 思考模式,通常需要 30 秒到 2 分钟。\n' +
  '请勿关闭面板。\n\n' +
  '完成后此处会自动显示优化结果。';

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 登录态检查 (跟客服磁贴口径一致)
function _isLoggedIn() {
  return !!TileAPI.state.get('cloud.loggedIn') && !!TileAPI.storage.get('cloud.token');
}

// 未登录冻结面板 — 跟 tile-support 一样的"去登录"风格
function _renderLoginGate(container) {
  container.innerHTML =
    '<div class="w10-panel">' +
      '<div class="w10-section-title">✨ 提示词优化</div>' +
      '<div class="support-empty" style="padding:24px;text-align:center;line-height:1.8">' +
        '🔐 提示词优化需要 <b>登录</b> 后才能使用<br>' +
        '<span style="font-size:12px;color:var(--text-sub,#888)">登录后才能调用云端 AI 模型 (deepseek-v4-pro)</span><br><br>' +
        '<button class="support-send-btn" id="optGotoLoginBtn">去登录</button>' +
      '</div>' +
    '</div>';
  var loginBtn = container.querySelector('#optGotoLoginBtn');
  if (loginBtn) loginBtn.addEventListener('click', function() {
    if (TileAPI && typeof TileAPI.expandTile === 'function') {
      TileAPI.expandTile('topbar');
    } else {
      TileAPI.toast('请打开顶部账号面板登录', 'info');
    }
  });
}

// ========== 正面 ==========
function renderFront(container, w, h) {
  var hasResult = _convo.length >= 2;
  var statusText = _optimizing ? '优化中...' : (hasResult ? '已优化 (可继续微调)' : 'AI 提示词优化');
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">✨</div>' +
      '<div class="tile-label">提示词优化</div>' +
      '<div class="tile-desc">' + _esc(statusText) + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">✨</div>' +
      '<div class="tile-label">优化</div>';
  }
}
function _refreshFront() {
  var el = window.TileEngine ? TileEngine.getTileElement('prompt-optimizer') : null;
  if (!el) return;
  var inner = el.querySelector('.tile-inner') || el.querySelector('.tile-flip-front');
  if (inner) renderFront(inner, +el.dataset.w || 1, +el.dataset.h || 1);
}

// ========== 展开 ==========
function onExpand(container, sizeHint) {
  _activeContainer = container;
  if (!_isLoggedIn()) {
    _renderLoginGate(container);
    return function cleanup() { _activeContainer = null; };
  }
  _renderPanel(container);
  return function cleanup() {
    if (_convo.length === 0) {
      var ta = container.querySelector('#optMain');
      if (ta && !ta.readOnly) _draft = ta.value || '';
    }
    _activeContainer = null;
  };
}

// ========== 顶栏 ==========
//  永远单行:badge + "优化"标题 + 三个操作按钮
//  优化中所有按钮 disabled,不抖动
function _renderHeadHTML() {
  var hasResult = _convo.length >= 2;
  var disabledAttr = _optimizing ? ' disabled' : '';

  var optimizeBtn = '<button class="prompt-preset-run" id="optBtnOptimize" title="' +
    (_optimizing ? '优化中…' : '调用 AI 优化') + '"' + disabledAttr + '>🚀</button>';

  var sendBtn = '<button class="prompt-preset-toggle" id="optBtnSend" title="发送到提示词面板"' +
    ((hasResult && !_optimizing) ? '' : ' disabled') + '>📤</button>';

  var clearBtn = '<button class="prompt-preset-unload" id="optBtnClear" title="清空全部"' + disabledAttr + '>×</button>';

  return '<div class="prompt-preset-head prompt-preset-head-optimizer">' +
    '<span class="prompt-preset-badge prompt-preset-badge-optimizer" title="提示词优化器">✨</span>' +
    '<div class="prompt-preset-info">' +
      '<div class="prompt-preset-title">优化</div>' +
    '</div>' +
    sendBtn + optimizeBtn + clearBtn +
  '</div>';
}

// ========== 主面板 ==========
function _renderPanel(container) {
  var hasResult = _convo.length >= 2;
  var lastResult = hasResult ? _convo[_convo.length - 1].content : '';
  var firstUser = _convo.length > 0 ? _convo[0].content : '';

  // 主 textarea 内容判定:
  //   优化中:显示进度提示(冻结)
  //   有结果:显示最新结果
  //   否则: 草稿/原始输入
  var mainText, mainReadOnly = false;
  if (_optimizing) {
    mainText = PROGRESS_MSG;
    mainReadOnly = true;
  } else if (hasResult) {
    mainText = lastResult;
  } else {
    mainText = firstUser || _draft || '';
  }

  // placeholder 在没内容、非优化中、没结果时,承担帮助说明
  var placeholder =
    '在此输入修图需求,然后点 🚀 优化。\n' +
    '\n' +
    '示例:\n' +
    '  · 把皮肤修得更光滑、面部更立体,但保持原始构图\n' +
    '  · 去掉背景的路人和杂物,环境扩展为日式神社外景\n' +
    '  · 在人物前方添加扫描线特效,只叠加不修改主体\n' +
    '\n' +
    'AI 会输出结构化的可执行提示词,可直接发送到提示词面板。';

  // followup 区域逻辑:
  //   优化中且已有结果:显示但禁用,文本冻结
  //   非优化中且已有结果:正常可用
  //   未优化过:不显示
  var showFollowup = hasResult;
  var followupReadOnly = _optimizing;
  var followupValue = '';
  if (showFollowup && _optimizing) {
    followupValue = _frozenFollowupText;
  }

  container.innerHTML =
    '<div class="w10-panel prompt-ta-panel optimizer-panel' + (_optimizing ? ' is-optimizing' : '') + '">' +
      _renderHeadHTML() +
      '<div class="prompt-ta-wrap prompt-ta-fill">' +
        '<textarea class="w10-input prompt-ta" id="optMain" ' +
          (mainReadOnly ? 'readonly ' : '') +
          'placeholder="' + _esc(placeholder) + '">' +
          _esc(mainText) +
        '</textarea>' +
      '</div>' +
      (showFollowup ?
        '<div class="optimizer-followup' + (_optimizing ? ' is-frozen' : '') + '">' +
          '<div class="optimizer-followup-bar">' +
            '<span class="optimizer-followup-icon">💬</span>' +
            '<span class="optimizer-followup-title">二次修改意见</span>' +
            '<button class="prompt-preset-run" id="optBtnRefine" title="根据意见再次优化"' +
              (_optimizing ? ' disabled' : '') + '>✨</button>' +
          '</div>' +
          '<textarea class="w10-input optimizer-followup-input" id="optFollowup" ' +
            (followupReadOnly ? 'readonly ' : '') +
            'placeholder="例如:再加一条保护规则,瞳孔颜色不能改变 / 把第三章的强度从 0.5 调到 0.7">' +
            _esc(followupValue) +
          '</textarea>' +
        '</div>'
        : ''
      ) +
    '</div>';

  _bindEvents(container);
}

function _bindEvents(container) {
  var mainEl = container.querySelector('#optMain');
  var btnOptimize = container.querySelector('#optBtnOptimize');
  var btnSend = container.querySelector('#optBtnSend');
  var btnClear = container.querySelector('#optBtnClear');
  var btnRefine = container.querySelector('#optBtnRefine');
  var followupEl = container.querySelector('#optFollowup');

  if (btnOptimize) btnOptimize.addEventListener('click', function() {
    if (_optimizing) return;
    var raw = (mainEl.value || '').trim();
    if (!raw) {
      TileAPI.toast('请输入需要优化的提示词', 'warn');
      return;
    }
    _convo = [{ role: 'user', content: raw }];
    _draft = '';
    _frozenMainText = raw;
    _frozenFollowupText = '';
    _setOptimizing(true);
    TileAPI.sendToHost('promptOptimize', { messages: _convo });
  });

  if (btnRefine) btnRefine.addEventListener('click', function() {
    if (_optimizing) return;
    var feedback = (followupEl && followupEl.value || '').trim();
    if (!feedback) {
      TileAPI.toast('请输入二次修改意见', 'warn');
      return;
    }
    _convo.push({ role: 'user', content: feedback });
    _frozenFollowupText = feedback;
    _setOptimizing(true);
    TileAPI.sendToHost('promptOptimize', { messages: _convo });
  });

  if (btnSend) btnSend.addEventListener('click', function() {
    if (_convo.length < 2) return;
    var text = _convo[_convo.length - 1].content;
    TileAPI.emit('prompt:changed', { text: text, source: 'optimizer' });
    TileAPI.toast('已发送到提示词面板', 'success');
  });

  if (btnClear) btnClear.addEventListener('click', function() {
    if (_optimizing) return;
    _convo = [];
    _draft = '';
    _frozenMainText = '';
    _frozenFollowupText = '';
    _renderPanel(container);
    _refreshFront();
  });

  // 暂存草稿:未优化前 / 非冻结期的输入
  if (mainEl) mainEl.addEventListener('input', function() {
    if (_optimizing) return;
    if (_convo.length === 0) _draft = mainEl.value;
  });
}

function _setOptimizing(flag) {
  _optimizing = flag;
  if (_activeContainer) _renderPanel(_activeContainer);
  _refreshFront();
}

// ========== 注册 ==========
TileAPI.registerTile({
  id: 'prompt-optimizer',
  group: 'main',
  icon: '✨',
  label: '优化',
  desc: 'AI 提示词优化',
  defaultSize: { w: 2, h: 3 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,
  onExpand: onExpand,

  onMessage: function(action, data) {
    if (action !== 'promptOptimizeResult') return;

    if (data && data.success && data.content) {
      _convo.push({ role: 'assistant', content: data.content });
      var info = '优化完成 (' + data.content.length + ' 字' +
        (typeof data.remaining === 'number' ? ', 本小时剩余 ' + data.remaining + ' 次' : '') + ')';
      TileAPI.toast(info, 'success');
      // 成功:解冻后 followup 内容已使用过,可以清掉
      _frozenFollowupText = '';
    } else {
      var errMsg = (data && data.error) || '未知错误';
      TileAPI.toast('优化失败: ' + errMsg, 'error');
      // 失败回滚最后一次 push 的 user
      if (_convo.length > 0 && _convo[_convo.length - 1].role === 'user') {
        _convo.pop();
      }
      // 失败时恢复 followup 框内容(如果是二次优化失败)
      // _frozenFollowupText 保留,_renderPanel 会用它回填
    }
    _setOptimizing(false);
  }
});

// 登录态变化 → 展开中的面板自动刷新
if (TileAPI && typeof TileAPI.on === 'function') {
  TileAPI.on('auth:loggedIn', function() {
    if (!_activeContainer) return;
    _renderPanel(_activeContainer);
  });
  TileAPI.on('auth:loggedOut', function() {
    if (!_activeContainer) return;
    _renderLoginGate(_activeContainer);
  });
}

})();
