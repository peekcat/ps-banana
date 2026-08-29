// ============================================================
//  tile-qa.js — 「帮助」磁贴
//  随包发布的 Q&A 帮助清单：目录 + 搜索（标题/标签/全文/拼音首字母）+ 详情
//  内容数据见 tile-qa.data.js（window.QA_DATA）
//  纯前端，无后端、不连网、不调 PS。
// ============================================================
(function() {
'use strict';

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ========== 数据访问 ==========
function _data() { return (window.QA_DATA && window.QA_DATA.categories) ? window.QA_DATA : { categories: [] }; }

function _findItem(id) {
  var cats = _data().categories;
  for (var i = 0; i < cats.length; i++) {
    var items = cats[i].items || [];
    for (var j = 0; j < items.length; j++) {
      if (items[j].id === id) return items[j];
    }
  }
  return null;
}

// ========== 搜索 ==========
// 四路匹配：标题 q / 标签 tags / 拼音首字母 py / 答案全文 a
function _match(item, q) {
  if (!q) return true;
  if (item.q && item.q.toLowerCase().indexOf(q) >= 0) return true;
  if (item.py && item.py.toLowerCase().indexOf(q) >= 0) return true;
  if (item.tags) {
    for (var i = 0; i < item.tags.length; i++) {
      if (String(item.tags[i]).toLowerCase().indexOf(q) >= 0) return true;
    }
  }
  if (item.a && item.a.toLowerCase().indexOf(q) >= 0) return true;
  return false;
}

// 在标题里高亮命中（先转义，再对转义后的串做大小写不敏感高亮）
function _highlight(text, q) {
  var safe = _esc(text);
  if (!q) return safe;
  try {
    var re = new RegExp('(' + _escRe(_esc(q)) + ')', 'ig');
    return safe.replace(re, '<mark class="qa-mark">$1</mark>');
  } catch (e) { return safe; }
}

// ========== 轻量 markdown（答案渲染）==========
// 支持：## 标题 / - 列表 / 1. 列表 / **粗** / `代码` / ![alt](src) 图片
// 参考 tiles/tile-chat.js 的 _markdownToHtml，裁剪为帮助文档够用的子集
function _qaMarkdown(text) {
  var html = _esc(text);

  // 图片 ![alt](src) —— src 来自我们自己的数据，可信，仍转义引号
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function(_, alt, src) {
    return '<img class="qa-md-img" src="' + _esc(src) + '" alt="' + _esc(alt) + '">';
  });

  // 标题（按行）
  html = html.replace(/^###\s+(.+)$/gm, '<div class="qa-md-h3">$1</div>');
  html = html.replace(/^##\s+(.+)$/gm, '<div class="qa-md-h2">$1</div>');
  html = html.replace(/^#\s+(.+)$/gm, '<div class="qa-md-h2">$1</div>');

  // 列表（按行）
  html = html.replace(/^\s*[-•]\s+(.+)$/gm, '<div class="qa-md-li">$1</div>');
  html = html.replace(/^\s*(\d+)\.\s+(.+)$/gm, '<div class="qa-md-li qa-md-li-num">$1. $2</div>');

  // 行内：粗体 / 代码
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code class="qa-md-code">$1</code>');

  // 剩余换行转 <br>，并清掉块元素周围多余的 <br>
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<\/div><br>/g, '</div>');
  html = html.replace(/<br>\s*(<div class="qa-md-)/g, '$1');
  html = html.replace(/(<img class="qa-md-img"[^>]*>)<br>/g, '$1');

  return html;
}

// ========== 正面 ==========
// 视图状态提到模块级：引擎在"响应式布局翻档"时会清空容器并重调 onExpand
// （见 core/tile-engine.js _applyPanelLayout），闭包内的状态会丢。
// 提到这里后，重渲能无缝恢复；只有真正收起（onCollapse）才清空。
var _qaOpenId = null;   // 当前打开的详情 id
var _qaQuery  = '';     // 当前搜索框内容（原样保存，匹配时再归一化）

function renderFront(container, w, h) {
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">❓</div>' +
      '<div class="tile-label">帮助</div>' +
      '<div class="tile-desc">常见问题</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">❓</div>' +
      '<div class="tile-label">帮助</div>';
  }
}

// ========== 列表渲染 ==========
function _renderList(listEl, query) {
  var cats = _data().categories;
  var html = '';

  if (!query) {
    // 无搜索：按分类分组显示目录
    if (!cats.length) {
      html = '<div class="qa-empty">暂无内容</div>';
    } else {
      for (var i = 0; i < cats.length; i++) {
        var c = cats[i];
        var items = c.items || [];
        if (!items.length) continue;
        html += '<div class="qa-cat-title">' + (c.icon ? c.icon + ' ' : '') + _esc(c.name) + '</div>';
        for (var j = 0; j < items.length; j++) {
          html += _itemRow(items[j], '');
        }
      }
    }
  } else {
    // 搜索态：扁平列出命中项
    var hits = [];
    for (var k = 0; k < cats.length; k++) {
      var its = cats[k].items || [];
      for (var m = 0; m < its.length; m++) {
        if (_match(its[m], query)) hits.push(its[m]);
      }
    }
    html += '<div class="qa-result-count">' + (hits.length ? ('找到 ' + hits.length + ' 条') : '没找到相关内容') + '</div>';
    for (var n = 0; n < hits.length; n++) {
      html += _itemRow(hits[n], query);
    }
  }

  listEl.innerHTML = html;
}

function _itemRow(item, query) {
  return '<div class="qa-item" data-qid="' + _esc(item.id) + '">' +
           '<span class="qa-item-q">' + _highlight(item.q, query) + '</span>' +
           '<span class="qa-arrow">›</span>' +
         '</div>';
}

// ========== 详情渲染 ==========
function _renderDetail(detailEl, item) {
  detailEl.innerHTML =
    '<div class="qa-detail-head">' +
      '<button class="qa-back" id="qaBackBtn">‹ 返回</button>' +
      '<div class="qa-detail-title">' + _esc(item.q) + '</div>' +
    '</div>' +
    '<div class="qa-md">' + _qaMarkdown(item.a || '') + '</div>';
}

// ========== 展开面板 ==========
function onExpand(container, sizeHint) {
  container.innerHTML =
    '<div class="w10-panel qa-panel">' +
      '<div class="qa-view qa-view-list" id="qaListView">' +
        '<div class="qa-search-wrap">' +
          '<span class="qa-search-icon">🔍</span>' +
          '<input class="qa-search" id="qaSearch" type="text" placeholder="搜索问题、关键词、拼音首字母…">' +
          '<span class="qa-search-clear" id="qaClear" style="display:none">✕</span>' +
        '</div>' +
        '<div class="qa-list" id="qaList"></div>' +
      '</div>' +
      '<div class="qa-view qa-view-detail" id="qaDetailView" style="display:none"></div>' +
    '</div>';

  var listView   = container.querySelector('#qaListView');
  var detailView = container.querySelector('#qaDetailView');
  var listEl     = container.querySelector('#qaList');
  var searchEl   = container.querySelector('#qaSearch');
  var clearEl    = container.querySelector('#qaClear');

  function showList() {
    _qaOpenId = null;
    if (detailView) detailView.style.display = 'none';
    if (listView) listView.style.display = '';
  }

  function openDetail(id) {
    var item = _findItem(id);
    if (!item || !detailView) return;
    _qaOpenId = id;
    _renderDetail(detailView, item);
    if (listView) listView.style.display = 'none';
    detailView.style.display = '';
    detailView.scrollTop = 0;
    var back = detailView.querySelector('#qaBackBtn');
    if (back) back.addEventListener('click', showList);
  }

  // 搜索：输入即过滤
  if (searchEl) {
    searchEl.addEventListener('input', function() {
      _qaQuery = String(this.value || '');
      var nq = _qaQuery.trim().toLowerCase();
      if (clearEl) clearEl.style.display = nq ? '' : 'none';
      if (listEl) _renderList(listEl, nq);
    });
  }
  if (clearEl) {
    clearEl.addEventListener('click', function() {
      _qaQuery = '';
      if (searchEl) { searchEl.value = ''; searchEl.focus(); }
      clearEl.style.display = 'none';
      if (listEl) _renderList(listEl, '');
    });
  }

  // 列表点击（事件委托）
  if (listEl) {
    listEl.addEventListener('click', function(e) {
      var row = null;
      var node = e.target;
      while (node && node !== listEl) {
        if (node.classList && node.classList.contains('qa-item')) { row = node; break; }
        node = node.parentNode;
      }
      if (row) {
        var id = row.getAttribute('data-qid');
        if (id) openDetail(id);
      }
    });
  }

  // 恢复上次视图状态（应对引擎在布局翻档时整体重渲 onExpand）
  var nq0 = _qaQuery.trim().toLowerCase();
  if (searchEl && _qaQuery) {
    searchEl.value = _qaQuery;
    if (clearEl) clearEl.style.display = nq0 ? '' : 'none';
  }
  if (listEl) _renderList(listEl, nq0);
  if (_qaOpenId && _findItem(_qaOpenId)) {
    openDetail(_qaOpenId);   // 引擎布局重渲后恢复到原详情
  }

  // 本磁贴无定时器 / 全局监听，cleanup 留空即可
  return function cleanup() {};
}

// ========== 注册 ==========
TileAPI.registerTile({
  id: 'qa',
  group: 'main',
  icon: '❓',
  label: '帮助',
  desc: '常见问题',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 12 },

  renderFront: renderFront,
  onResize: renderFront,
  onExpand: onExpand,

  // 真正收起时才重置视图（布局翻档的重渲不会触发 onCollapse，状态得以保留）
  onCollapse: function() { _qaOpenId = null; _qaQuery = ''; },
});

})();
