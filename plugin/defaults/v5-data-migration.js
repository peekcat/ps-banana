/**
 * defaults/v5-data-migration.js — v5.4.6 → v6.0 数据迁移
 *
 * 场景：v6 复用了 v5 的插件 ID (com.xiasanqi.ps.wheelchair.v4)，所以从 v5 升级上来后
 *       webview_storage.json 里同时存在 v5 老 key 和 v6 新 key。
 *
 *       v5 老 key 都是平铺字符串(saved_api_key / saved_api_url / chat_api_url ...)
 *       v6 新 key 是 namespace 化的(connection.aji.key / chat.url ...)
 *
 * 策略：
 *   - 一次性弹窗询问用户是否迁移（用 __v5_migration_done 标记防止重问）
 *   - 用户同意 → 只迁少量高价值字符串 key (API key/URL)
 *   - 不迁结构变化的 key (chat_sessions, forge_preset_state 等) — 这些只能要求用户重新设
 *   - 不迁布尔/枚举类(value 格式从 v5 的 'true'/'false' 字符串变成 v6 的 bool) — 风险高
 *
 * 为什么这么做：
 *   - v6 自带的 LEGACY_KEY_MAP 用的 key 名(gen_api_url / ui_theme)v5 实际从未用过，是错的
 *   - 大部分 v5 设置在 v6 默认值下也合理，重新调一次 < 调试迁移 bug 风险
 *   - 只迁 API key 解决"用户最痛的痛点"(免去重新登录/复制粘贴 token)
 */
(function() {
'use strict';

var MIGRATION_FLAG = '__v5_migration_done';

// v5 老 key → v6 新 key (仅字符串/URL 类，结构未变)
var KEY_MAP = {
  // AJI / 主 API
  'saved_api_url': 'connection.aji.url',
  'saved_api_key': 'connection.aji.key',
  // GRS
  'grs_host': 'connection.grs.url',
  'grs_apikey': 'connection.grs.key',
  // 当前 provider 选择
  'api_provider': 'connection.provider',
  // 聊天磁贴的 API (与生成可不同)
  'chat_api_url': 'chat.url',
  'chat_api_key': 'chat.key',
  'chat_model': 'chat.model',
  // ComfyUI / Forge URL (URL 类没结构问题)
  'comfyui_url': 'comfyui.url',
  'forgeApiUrl': 'forge.url'
};

// 用来判断"是否检测到 v5 数据存在"的 sentinel key
// 任何一个有值就认为机器装过 v5
var V5_SENTINELS = ['saved_api_key', 'saved_api_url', 'chat_api_key', 'forgeApiUrl', 'grs_apikey'];

/**
 * 检查是否需要弹窗。
 * 返回：
 *   'ask'   → 检测到 v5 数据，需要弹窗
 *   'none'  → 没有 v5 数据，跳过（新用户或已无残留）
 *   'done'  → 已经处理过了
 */
function _checkState() {
  if (!window.TileAPI || !TileAPI.storage) return 'done';

  var flagged = TileAPI.storage.get(MIGRATION_FLAG);
  if (flagged) return 'done';

  // 检测任意 sentinel
  for (var i = 0; i < V5_SENTINELS.length; i++) {
    var v = TileAPI.storage.get(V5_SENTINELS[i]);
    if (v != null && v !== '') return 'ask';
  }
  return 'none';
}

/**
 * 执行 API key 迁移
 * 返回迁移成功的 key 数量
 */
function _doMigrate() {
  var migrated = 0;
  var oldKeys = Object.keys(KEY_MAP);
  for (var i = 0; i < oldKeys.length; i++) {
    var oldK = oldKeys[i];
    var newK = KEY_MAP[oldK];
    var oldVal = TileAPI.storage.get(oldK);
    if (oldVal == null || oldVal === '') continue;
    // 不覆盖已存在的 v6 值(用户在 v6 里改过则尊重)
    var existing = TileAPI.storage.get(newK);
    if (existing != null && existing !== '') continue;
    TileAPI.storage.set(newK, oldVal);
    migrated++;
  }
  return migrated;
}

function runV5DataMigration() {
  var state = _checkState();

  if (state === 'done' || state === 'none') return;

  if (!window.UIKit || typeof UIKit.dialog !== 'function') {
    // UIKit 没就绪，先不动；下次启动还能再问
    return;
  }

  UIKit.dialog({
    title: '检测到旧版本(v5.x)的数据',
    html:
      '<div style="line-height:1.7;font-size:12px;">' +
        '<div style="margin-bottom:10px;">v6.0 检测到你之前安装过 v5 版本的设置。</div>' +
        '<div style="margin-bottom:8px;color:var(--accent,#4fc3f7);font-weight:600;">可以自动迁移：</div>' +
        '<ul style="margin:0 0 10px 18px;font-size:11px;line-height:1.7;color:var(--text-sub);">' +
          '<li>API 密钥（AJI / GRS / 聊天）</li>' +
          '<li>API 地址</li>' +
          '<li>ComfyUI / Forge URL</li>' +
        '</ul>' +
        '<div style="margin-bottom:8px;color:var(--warn,#ff9800);font-weight:600;">不会迁移（请重新设置）：</div>' +
        '<ul style="margin:0 0 10px 18px;font-size:11px;line-height:1.7;color:var(--text-sub);">' +
          '<li>主题/界面外观</li>' +
          '<li>聊天历史 / 角色配置</li>' +
          '<li>Forge 收藏 / 预设</li>' +
          '<li>所有开关（v5 与 v6 数据格式不兼容）</li>' +
        '</ul>' +
        '<div style="font-size:11px;color:var(--text-sub);">（如果选"不迁移"，所有设置保持 v6 默认值，旧数据保留在磁盘但不读取。）</div>' +
      '</div>',
    buttons: ['不迁移', '迁移 API 设置'],
    accent: 1,
    escIndex: 0
  }).then(function(result) {
    var idx = (result && result.index != null) ? result.index : 0;
    TileAPI.storage.set(MIGRATION_FLAG, true);
    if (idx === 1) {
      var n = _doMigrate();
      if (n > 0) {
        TileAPI.toast('已迁移 ' + n + ' 项 API 设置', 'success');
      } else {
        TileAPI.toast('未发现可迁移的 API 设置', 'info');
      }
    }
  });
}

window._v5DataMigration = {
  run: runV5DataMigration
};

})();
