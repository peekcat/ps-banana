/**
 * defaults/layout-migration.js — 新版默认布局迁移
 *
 * 场景：v6.0 之前的测试版发给用户后，用户自己排好了界面；
 *       v6.0 (3) 引入了夏三七调校的默认布局，需要询问老用户是否切换。
 *
 * 规则：
 *   1. 启动时检测 __layout_migration_v6_3 标记
 *      - 已经问过 → 不再打扰
 *      - 未问过：
 *          a. 用户存储里没有 __tile_layout_v6 → 新用户，不弹窗，直接写入标记
 *          b. 有 __tile_layout_v6 → 老用户，弹窗询问
 *
 *   2. 弹窗结果：
 *      - [切换到默认]：用 _DEFAULT_LAYOUT 覆盖完整布局和 Dock 设置，写入标记后刷新
 *      - [保留我的布局]：只写入标记，不动任何数据
 *
 * 迁移范围（仅 UI 外观，不含凭证/预设/历史等个人数据）：
 *   __tile_layout_v6 / __tile_expand_modes / __tile_colors /
 *   __tile_folders_v6 / __tile_drawer_stash_v6 /
 *   appearance.themeColor / appearance.blur / appearance.opacity / appearance.tileColorOpacity /
 *   dock.items / dock.side / dock.scale / dock.iconScale / dock.opacity / dock.blur
 */
(function() {
'use strict';

var MIGRATION_FLAG = '__layout_migration_v6_3';

// 要迁移的键（完整覆盖）
var LAYOUT_KEYS = [
  '__tile_layout_v6',
  '__tile_expand_modes',
  '__tile_colors',
  '__tile_folders_v6',
  '__tile_drawer_stash_v6',
  'appearance.themeColor',
  'appearance.blur',
  'appearance.opacity',
  'appearance.tileColorOpacity',
  'dock.items',
  'dock.side',
  'dock.scale',
  'dock.iconScale',
  'dock.opacity',
  'dock.blur'
];

/**
 * 判断是否需要询问用户迁移。
 * 返回：
 *   'ask'   → 老用户，需要弹窗
 *   'new'   → 新用户，直接用默认，写标记
 *   'done'  → 已经问过，跳过
 */
function _checkMigrationState() {
  if (!window.TileAPI || !TileAPI.storage) return 'done';

  var flagged = TileAPI.storage.get(MIGRATION_FLAG);
  if (flagged) return 'done';

  // 没标记 → 判断是新老用户
  // 老用户一定有自己排过的布局（__tile_layout_v6）
  // 注意：_DEFAULT_LAYOUT 在 storage-manager.js 启动时已写入 _memoryStore，
  //      但用户 storage 加载时如果有自己的值会覆盖。
  //      所以这里判断「用户是不是之前没有自己的布局」不能直接用 get(__tile_layout_v6)
  //      （因为默认值也会命中），得对比是否与 _DEFAULT_LAYOUT 里的 __tile_layout_v6 完全相同。
  var curLayout = TileAPI.storage.get('__tile_layout_v6');
  var defLayout = (window._DEFAULT_LAYOUT && window._DEFAULT_LAYOUT['__tile_layout_v6']) || null;

  if (!curLayout) return 'new';

  // 如果当前布局和默认布局完全一致，判为新用户（用户从未改过）
  try {
    if (JSON.stringify(curLayout) === JSON.stringify(defLayout)) return 'new';
  } catch(e) {}

  return 'ask';
}

/**
 * 用默认布局覆盖用户存储
 */
function _applyDefaultLayout() {
  if (!window._DEFAULT_LAYOUT || !window.TileAPI || !TileAPI.storage) return;
  for (var i = 0; i < LAYOUT_KEYS.length; i++) {
    var k = LAYOUT_KEYS[i];
    if (window._DEFAULT_LAYOUT[k] !== undefined) {
      TileAPI.storage.set(k, window._DEFAULT_LAYOUT[k]);
    } else {
      // 默认里没这个键 → 删掉用户的（比如抽屉、文件夹默认为空）
      TileAPI.storage.remove(k);
    }
  }
}

/**
 * 弹窗询问（在磁贴加载完之后调用）。
 * 用户选择后会写入标记；选「切换」时应用默认布局并重载。
 */
function runLayoutMigration() {
  var state = _checkMigrationState();

  if (state === 'done') return;

  if (state === 'new') {
    TileAPI.storage.set(MIGRATION_FLAG, true);
    return;
  }

  // state === 'ask' → 弹窗
  if (!window.UIKit || typeof UIKit.dialog !== 'function') {
    // UIKit 还没就绪，兜底：直接写标记避免卡住
    TileAPI.storage.set(MIGRATION_FLAG, true);
    return;
  }

  UIKit.dialog({
    title: '是否应用新版默认界面布局？',
    html:
      '<div style="line-height:1.7;font-size:12px;">' +
        '<div style="margin-bottom:8px;">检测到你的界面布局是旧版本。</div>' +
        '<div style="margin-bottom:8px;">是否切换到夏三七调校的默认布局？</div>' +
        '<div style="color:var(--text-sub);font-size:11px;">（你自己的预设、API Key、历史记录不会丢）</div>' +
      '</div>',
    buttons: ['保留我的布局', '切换到默认'],
    accent: 1,
    escIndex: 0
  }).then(function(result) {
    var idx = (result && result.index != null) ? result.index : 0;
    // 无论选哪个都写标记，避免再次打扰
    TileAPI.storage.set(MIGRATION_FLAG, true);

    if (idx === 1) {
      // 切换到默认
      _applyDefaultLayout();
      TileAPI.toast('已应用默认布局，即将刷新…', 'success');
      setTimeout(function() {
        try { location.reload(); } catch(e) {}
      }, 600);
    }
  });
}

// 暴露给 app.js
window._layoutMigration = {
  run: runLayoutMigration
};

})();
