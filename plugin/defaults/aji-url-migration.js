/**
 * defaults/aji-url-migration.js — 强制清掉用户手填的 AJI URL (v6.2.5+)
 *
 * 场景: 6.2.5 起 AJI URL 不再让用户填, 全部由服务端 /api/aji-urls 下发,
 *       客户端跑赛马选最快可用的. 老用户 storage 里可能有自己填的 URL,
 *       要清掉, 强制走"填 Key → 自动校验/赛马"流程.
 *
 * 策略:
 *   - 用 __aji_url_migrate_v625 标记防重复
 *   - 直接 remove storage.connection.aji.url
 *   - 不弹窗、不通知, 用户下次填 Key 粘贴时会自动触发校验
 */
(function() {
'use strict';

var MIGRATION_FLAG = '__aji_url_migrate_v625';

function runAjiUrlMigration() {
  if (!window.TileAPI || !TileAPI.storage) return;
  if (TileAPI.storage.get(MIGRATION_FLAG)) return;

  var oldUrl = TileAPI.storage.get('connection.aji.url');
  if (oldUrl) {
    try { TileAPI.storage.remove('connection.aji.url'); } catch(_) {}
    console.log('[aji-url-migration] 已清理用户手填的 AJI URL: ' + oldUrl + ' (改由服务端赛马自动选择)');
  }
  TileAPI.storage.set(MIGRATION_FLAG, true);
}

window._ajiUrlMigration = { run: runAjiUrlMigration };
})();
