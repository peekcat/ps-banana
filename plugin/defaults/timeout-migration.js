/**
 * defaults/timeout-migration.js — 超时默认值升级 (v6.1.6+)
 *
 * 场景：6.1.6 之前默认 90s,GPT-Image 异步轮询 + 大图很容易卡住。
 *       6.1.6 起默认 300s。已经存档过 90 秒的老用户升级后仍是 90,得静默拉上来。
 *
 * 策略:
 *   - 用 __timeout_migration_v616 标记防重复
 *   - 仅当用户当前 params.timeout < 200 时强制改 300(认为是老默认或被改得过低)
 *   - 用户自己设过更高(>= 200) → 尊重原值,不改
 *   - 不弹窗、不通知,完全静默
 */
(function() {
'use strict';

var MIGRATION_FLAG = '__timeout_migration_v616';
var THRESHOLD = 3600;
var NEW_DEFAULT = 3600;

function runTimeoutMigration() {
  if (!window.TileAPI || !TileAPI.storage) return;
  if (TileAPI.storage.get(MIGRATION_FLAG)) return;

  var cur = TileAPI.storage.get('params.timeout');
  // 没值 → 不动(初始化逻辑会自己用 300)
  // 有值且小于阈值 → 升级
  if (typeof cur === 'number' && cur > 0 && cur < THRESHOLD) {
    TileAPI.storage.set('params.timeout', NEW_DEFAULT);
    if (TileAPI.state) TileAPI.state.set('params.timeout', NEW_DEFAULT);
    console.log('[timeout-migration] 默认超时已从 ' + cur + 's 升级到 ' + NEW_DEFAULT + 's');
  }
  TileAPI.storage.set(MIGRATION_FLAG, true);
}

window._timeoutMigration = { run: runTimeoutMigration };
})();
