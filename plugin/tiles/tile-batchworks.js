// ============================================================
//  tile-batchworks.js — 🏭 批量工场 (v6.5.0 三期)
//  📋批处理(batch) | 🗺️全局分区(partition) | 🔲分块放大(tiled) 三页签
//
//  壳磁贴方案(评估③定稿): 三家前端/host 逻辑零改动, 用 MountKit.tabs
//  同一时刻只挂一个页 → 老磁贴的"单容器假设"不冲突; 切页先卸载前一个。
//  batch/partition/tiled 三个磁贴保留注册(挂载依赖 getTileDef; 想单独摆的
//  老用户也仍能从磁贴商店拖出), 但默认布局/迁移都指向本磁贴。
// ============================================================
(function() {
'use strict';

TileAPI.registerTile({
  id: 'batchworks',
  group: 'main',
  icon: '🏭',
  label: '批量工场',
  desc: '批处理 · 分区 · 分块放大',
  live: true,
  defaultSize: { w: 2, h: 2 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: function(container, w) {
    // 队列有货时正面显示数量(继承 batch 磁贴的角标习惯)
    var q = (TileAPI.state.get('batch.queue') || []).length;
    if (w >= 2) {
      container.innerHTML =
        '<div class="tile-icon">🏭</div>' +
        '<div class="tile-label">批量工场</div>' +
        '<div class="tile-desc">' + (q > 0 ? ('队列 ' + q + ' 单') : '批处理 · 分区 · 放大') + '</div>';
    } else {
      container.innerHTML =
        '<div class="tile-icon">🏭</div>' +
        '<div class="tile-label">批量工场' + (q > 0 ? ' ' + q : '') + '</div>';
    }
  },
  renderBack: function(c) {
    var q = (TileAPI.state.get('batch.queue') || []).length;
    c.textContent = q > 0 ? ('批处理队列 ' + q + ' 单') : '批处理 · 分区 · 放大';
  },

  onExpand: function(container) {
    if (!window.MountKit) {
      container.innerHTML = '<div class="w10-panel"><div class="w10-row-desc">MountKit 未加载, 请重启插件。</div></div>';
      return function() {};
    }
    var host = document.createElement('div');
    host.className = 'w10-panel';
    container.appendChild(host);
    return MountKit.tabs(host, [
      { id: 'batch',     label: '📋 批处理',   mount: function(b) { return MountKit.mountTile('batch', b); } },
      { id: 'partition', label: '🗺️ 全局分区', mount: function(b) { return MountKit.mountTile('partition', b); } },
      { id: 'tiled',     label: '🔲 分块放大', mount: function(b) { return MountKit.mountTile('tiled', b); } }
    ], { storageKey: 'batchworks.tab' });
  }
});

})();
