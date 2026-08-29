/**
 * storage-manager.js — 记忆系统
 * 负责保存和读取用户设置，支持namespace，兼容旧版数据
 */
(function() {
'use strict';

var _memoryStore = {};

// 是否已经从 host 加载过"真数据"。
// 防 RISK: 启动时 _memoryStore 预填了默认布局; 若 storageLoaded 超时(app.js 10s 兜底)
//   导致 loadAll 从未执行, 后续任何 set/remove 会把默认值写回磁盘, 永久覆盖用户真数据。
//   所以: 未加载真数据前, 内存照常更新(界面能跑), 但绝不落盘(localStorage/host 文件)。
var _loaded = false;

// 插件默认布局(window._DEFAULT_LAYOUT 由 defaults/default-layout.js 注入)
// 仅当用户还没有任何保存值时作为 fallback — 任何 loadAll 过来的值都会覆盖
if (window._DEFAULT_LAYOUT && typeof window._DEFAULT_LAYOUT === 'object') {
  var _defKeys = Object.keys(window._DEFAULT_LAYOUT);
  for (var _di = 0; _di < _defKeys.length; _di++) {
    _memoryStore[_defKeys[_di]] = window._DEFAULT_LAYOUT[_defKeys[_di]];
  }
}

// 旧版KEYS到新namespace的映射 (用于自动迁移)
var LEGACY_KEY_MAP = {
  'gen_api_url': 'connection.apiUrl',
  'gen_api_key': 'connection.apiKey',
  'gen_model': 'generate.model',
  'gen_size': 'generate.size',
  'gen_aspect_ratio': 'generate.aspectRatio',
  'gen_batch_size': 'generate.batchSize',
  'gen_timeout': 'generate.timeout',
  'ui_theme': 'appearance.themeColor',
  'ui_bg_image': 'appearance.bgImage',
  'ui_bg_pos_x': 'appearance.bgPosX',
  'ui_bg_pos_y': 'appearance.bgPosY',
  'ui_bg_zoom': 'appearance.bgZoom',
  'ui_opacity': 'appearance.opacity',
  'ui_blur': 'appearance.blur',
  'ui_scale': 'appearance.scale',
  'ui_text_mode': 'appearance.textMode',
  'ui_simple_mode': 'appearance.simpleMode',
  'gen_sound': 'sound.enabled',
  'gen_group': 'output.autoGroup',
  'gen_layer_type': 'output.layerType',
  'gen_max_resolution': 'output.maxResolution',
  'gen_compress_format': 'output.compressFormat',
  'gen_jpeg_quality': 'output.jpegQuality',
  'forge_enabled': 'forge.enabled',
  'forge_url': 'forge.url',
  'comfyui_url': 'comfyui.url',
  'comfyui_enabled': 'comfyui.enabled',
  'chat_api_url': 'chat.apiUrl',
  'chat_api_key': 'chat.apiKey',
  'chat_model': 'chat.model',
  'prompt_presets': 'presets.data',
  'gen_history': 'history.data',
};

// 布局存储key
var LAYOUT_KEY = '__tile_layout_v6';
var GROUPS_KEY = '__tile_groups_v6';
var MIGRATED_KEY = '__v6_migrated';

var StorageManager = {
  /**
   * 读取一个值
   */
  get: function(key) {
    // 先查内存
    if (_memoryStore[key] !== undefined) return _memoryStore[key];
    // 再查localStorage
    try {
      var v = localStorage.getItem(key);
      if (v !== null) {
        try { return JSON.parse(v); } catch(e) { return v; }
      }
    } catch(e) {}
    return null;
  },

  /**
   * 保存一个值
   */
  set: function(key, value) {
    _memoryStore[key] = value;
    // 未加载真数据前不落盘, 防止默认值覆盖磁盘上的用户数据(见顶部 _loaded 注释)
    if (!_loaded) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
    // 同步到后端文件存储
    if (window._messageBridge) {
      window._messageBridge.sendToHost('storageSet', { key: key, value: JSON.stringify(value) });
    }
  },

  /**
   * 删除一个值
   */
  remove: function(key) {
    delete _memoryStore[key];
    if (!_loaded) return;
    try { localStorage.removeItem(key); } catch(e) {}
    if (window._messageBridge) {
      window._messageBridge.sendToHost('storageRemove', { key: key });
    }
  },

  /**
   * 批量加载 (后端发来storageLoaded时调用)
   */
  loadAll: function(data) {
    // 标记"真数据已到"——即使 data 为空(首次启动 host 返回 {}),也算加载过,允许后续落盘
    _loaded = true;
    if (!data) return;
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = data[k];
      // 尝试parse JSON字符串
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch(e) {}
      }
      _memoryStore[k] = v;
    }
  },

  /**
   * 从旧版迁移数据
   */
  migrateFromLegacy: function() {
    if (this.get(MIGRATED_KEY)) return; // 已迁移过

    var migrated = false;
    var legacyKeys = Object.keys(LEGACY_KEY_MAP);
    for (var i = 0; i < legacyKeys.length; i++) {
      var oldKey = legacyKeys[i];
      var newKey = LEGACY_KEY_MAP[oldKey];
      var val = this.get(oldKey);
      if (val !== null && this.get(newKey) === null) {
        this.set(newKey, val);
        migrated = true;
      }
    }

    if (migrated) {
      this.set(MIGRATED_KEY, true);
    }
  },

  // 布局存储
  getLayout: function() { return this.get(LAYOUT_KEY) || null; },
  setLayout: function(layout) { this.set(LAYOUT_KEY, layout); },

  // 分组存储
  getGroups: function() { return this.get(GROUPS_KEY) || null; },
  setGroups: function(groups) { this.set(GROUPS_KEY, groups); },

  // 暴露常量
  LAYOUT_KEY: LAYOUT_KEY,
  GROUPS_KEY: GROUPS_KEY,
};

window._storageManager = StorageManager;
})();
