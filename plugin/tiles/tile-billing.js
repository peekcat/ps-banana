(function() {
'use strict';

// ============================================================
//  tile-billing.js —— 算力账单磁贴
//  · AJI / 夏算力(grs): 本地按任务流水累计花费 + 读现有实时余额/积分
//      流水来源: 模块级监听 generate:complete, 每出一张图记一笔
//      单价: 从模型视图 models.<provider>[model].prices[size] 取(真实ID计费)
//  · 墨墨(momo): 通过 new-api 接口 /api/billing/token 拉取消费(无余额接口)
//  说明: 流水只在前端本地, 估算值; 充值/退款/系统赠送不计入, 以服务端余额为准。
// ============================================================

var LEDGER_KEY = 'billing.ledger';   // [{ts, provider, model, size, count, unit, cost}]
var MAX_LEDGER = 3000;               // 环形上限, 超出丢最旧
var MOMO_BASE_URL = 'https://api.momoapi.icu';
var MOMO_QUOTA_PER_USD = 500000;      // new-api 默认: 500000 quota = 1 美元

// 本地计花费的算力(momo 单价靠价目表估算, 也进本地流水 — 项目开销要按文档拆分只能靠本地记)
var LOCAL_PROVIDERS = ['aji', 'grs', 'others', 'momo'];

// ============================================================
//  墨墨价目表: 固定价可立即估算；倍率价必须等待真实账单后回填。
//  网络统一走 Host，避免 UXP 前端直接 fetch /api/* 时被 CORS 拦截。
// ============================================================
var MOMO_PRICES_KEY = 'billing.momoPrices';
var _momoPricesFetched = false;
var _momoPricesFetching = false;

function _finiteNumber(v) {
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function _cleanMomoKey() {
  return String(TileAPI.storage.get('connection.momo.key') || '').replace(/\s+/g, '');
}

// 只保存不可逆短指纹，不把 Key 复制进账单流水。用途是防止用户换 Key 后串账。
function _momoKeyTag() {
  var key = _cleanMomoKey();
  if (!key) return '';
  var h = 2166136261;
  for (var i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'k_' + ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

function _readMomoCatalog() {
  var raw = TileAPI.storage.get(MOMO_PRICES_KEY) || {};
  if (raw && raw.version === 2 && raw.models && typeof raw.models === 'object') return raw;

  // 兼容旧版 { modelName: number } 缓存，旧数字只能代表固定价。
  var legacy = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.keys(raw).forEach(function(name) {
      var n = _finiteNumber(raw[name]);
      if (n != null) legacy[name] = { quotaType: 1, modelPrice: n, legacy: true };
    });
  }
  return { version: 2, fetchedAt: 0, models: legacy };
}

function _findMomoCatalogModel(model) {
  var models = _readMomoCatalog().models || {};
  if (Object.prototype.hasOwnProperty.call(models, model)) return models[model];
  var wanted = String(model || '').trim().toLowerCase();
  if (!wanted) return null;
  var found = null;
  var ambiguous = false;
  Object.keys(models).forEach(function(name) {
    if (String(name).trim().toLowerCase() !== wanted) return;
    if (found) ambiguous = true;
    else found = models[name];
  });
  return ambiguous ? null : found;
}

function _buildMomoCatalog(rows) {
  var models = {};
  for (var i = 0; i < rows.length; i++) {
    var m = rows[i] || {};
    var name = String(m.model_name || '').trim();
    if (!name) continue;
    var quotaType = _finiteNumber(m.quota_type);
    models[name] = {
      quotaType: quotaType,
      modelPrice: _finiteNumber(m.model_price),
      modelRatio: _finiteNumber(m.model_ratio),
      completionRatio: _finiteNumber(m.completion_ratio),
      cacheRatio: _finiteNumber(m.cache_ratio),
      imageRatio: _finiteNumber(m.image_ratio),
      audioRatio: _finiteNumber(m.audio_ratio),
      audioCompletionRatio: _finiteNumber(m.audio_completion_ratio)
    };
  }
  return { version: 2, fetchedAt: Date.now(), models: models };
}

// 兼容升级前已经写进本地、但没有 pricingStatus 的墨墨流水。
// 固定价可以安全精确补回；倍率价只自动接管“今天 + 当前 Key”的记录，
// 更早的无 Key 指纹历史无法可靠判断属于哪个账号，只标成历史金额未知，不凭空猜价。
function _migrateLegacyMomoLedger() {
  var ledger = _getLedger();
  var catalog = _readMomoCatalog();
  var catalogReady = Object.keys(catalog.models || {}).length > 0;
  var keyTag = _momoKeyTag();
  var todayStart = _todayStart();
  var changed = false;
  var needsBilling = false;
  for (var i = 0; i < ledger.length; i++) {
    var e = ledger[i];
    if (!e || e.provider !== 'momo' || e.pricingStatus) continue;
    var price = _findMomoCatalogModel(e.model || '');
    if (price && price.quotaType === 1 && price.modelPrice != null) {
      e.unit = price.modelPrice;
      e.cost = price.modelPrice * (+e.count || 0);
      e.pending = false;
      e.momoQuotaType = 1;
      e.pricingStatus = 'fixed';
      e.pricingSource = 'legacy-catalog-fixed';
      e.pricedAt = Date.now();
      changed = true;
      continue;
    }
    if ((+e.cost || 0) > 0 || (+e.unit || 0) > 0) {
      e.pending = false;
      e.pricingStatus = 'legacy-priced';
      e.pricingSource = 'legacy-existing-value';
      changed = true;
      continue;
    }
    // 首次启动、价目表尚未拉回时先保持原样，避免把其实是固定价的老记录过早封成“历史未知”。
    if (!catalogReady || !keyTag) continue;
    e.momoQuotaType = price ? price.quotaType : null;
    if ((+e.ts || 0) >= todayStart) {
      e.pending = true;
      e.pricingStatus = 'pending';
      e.pricingSource = price && price.quotaType === 0 ? 'legacy-ratio-awaiting-billing' : 'legacy-catalog-awaiting';
      e.momoKeyTag = keyTag;
      needsBilling = true;
    } else {
      e.pending = false;
      e.pricingStatus = 'legacy-unpriced';
      e.pricingSource = 'legacy-key-unknown';
    }
    changed = true;
  }
  if (changed) {
    _saveLedger(ledger);
    TileAPI.emit('billing:updated', { provider: 'momo' });
  }
  return { changed: changed, needsBilling: needsBilling };
}

function _applyMomoCatalogToPending() {
  var keyTag = _momoKeyTag();
  if (!keyTag) return false;
  var ledger = _getLedger();
  var changed = false;
  for (var i = 0; i < ledger.length; i++) {
    var e = ledger[i];
    if (!e || e.provider !== 'momo' || e.pricingStatus !== 'pending' || e.momoKeyTag !== keyTag) continue;
    var price = _findMomoCatalogModel(e.model || '');
    if (!price || price.quotaType !== 1 || price.modelPrice == null) continue;
    e.unit = price.modelPrice;
    e.cost = price.modelPrice * (+e.count || 0);
    e.pending = false;
    e.momoQuotaType = 1;
    e.pricingStatus = 'fixed';
    e.pricingSource = 'catalog-fixed';
    e.pricedAt = Date.now();
    changed = true;
  }
  if (changed) {
    _saveLedger(ledger);
    TileAPI.emit('billing:updated', { provider: 'momo' });
  }
  return changed;
}

function _fetchMomoPricesOnce() {
  if (_momoPricesFetched || _momoPricesFetching) return;
  var cachedMigration = _migrateLegacyMomoLedger();
  _applyMomoCatalogToPending();
  if (cachedMigration.needsBilling) _scheduleMomoBillingRefresh();
  if (!_cleanMomoKey()) return;
  _momoPricesFetching = true;
  _momoCall(_momoPricesCbs, 'momoFetchPrices', {}, function(resp) {
    _momoPricesFetching = false;
    if (!resp || !resp.success || !Array.isArray(resp.data)) return;
    TileAPI.storage.set(MOMO_PRICES_KEY, _buildMomoCatalog(resp.data));
    _momoPricesFetched = true;
    var migration = _migrateLegacyMomoLedger();
    _applyMomoCatalogToPending();
    if (migration.needsBilling) _scheduleMomoBillingRefresh();
  });
}
// 启动 4 秒后拉一次(等 storage 就绪); 之后每次打开账单面板也会补拉
setTimeout(_fetchMomoPricesOnce, 4000);
TileAPI.on('params:modelsFetched', function(data) {
  if (data && data.provider === 'momo') _fetchMomoPricesOnce();
});

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _getLedger() {
  var l = TileAPI.storage.get(LEDGER_KEY);
  return Array.isArray(l) ? l : [];
}
function _saveLedger(l) {
  if (l.length > MAX_LEDGER) l = l.slice(l.length - MAX_LEDGER);
  TileAPI.storage.set(LEDGER_KEY, l);
}

function _todayStart() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 单价单位: aji=美元, grs=积分, others=未知(价目表为0)
function _unitOf(provider) {
  if (provider === 'grs') return 'pts';
  return 'USD';
}
function _fmtMoney(provider, v) {
  if (v == null || isNaN(v)) return '—';
  if (_unitOf(provider) === 'pts') return Math.round(v).toLocaleString() + ' 分';
  return '$' + (+v).toFixed(4);
}

// ============================================================
//  记账: 每张图完成时记一笔(模块级常驻, 面板没开也记)
// ============================================================
function _recordLedger(data) {
  if (!data) return;
  var provider = data.provider;
  if (LOCAL_PROVIDERS.indexOf(provider) === -1) return;  // forge 等不进本地流水
  // 计费时机规则(用户定, 2026-08-02):
  //   aji  = 发送即扣费 → 按发起张数记(成功+失败)
  //   grs/momo = 不成功不扣费 → 只按成功张数记
  var count;
  if (provider === 'aji') {
    count = (+data.generatedSuccess || +data.success || 0) + (+data.fail || 0);
  } else {
    count = +data.generatedSuccess || +data.success || 0;
  }
  if (count <= 0) return;
  var model = data.model || '';
  var size = data.size || '';
  var unit = 0;
  var pricingStatus = 'catalog';
  var pricingSource = 'model-view';
  var pendingPrice = false;
  var momoQuotaType = null;
  if (provider === 'momo') {
    var momoPrice = _findMomoCatalogModel(model);
    momoQuotaType = momoPrice && momoPrice.quotaType;
    if (momoPrice && momoPrice.quotaType === 1 && momoPrice.modelPrice != null) {
      unit = momoPrice.modelPrice;
      pricingStatus = 'fixed';
      pricingSource = 'catalog-fixed';
    } else {
      // 倍率价无法只凭 model_ratio 换算美元；保留流水，等真实账单按模型均价回填。
      pendingPrice = true;
      pricingStatus = 'pending';
      pricingSource = momoPrice && momoPrice.quotaType === 0 ? 'ratio-awaiting-billing' : 'catalog-awaiting';
    }
  } else {
    var view = TileAPI.state.get('models.' + provider) || {};
    var mc = view[model] || {};
    if (!size) size = mc.default || '1K';
    unit = (mc.prices && typeof mc.prices[size] === 'number') ? mc.prices[size] : 0;
  }
  var entry = {
    ts: Date.now(),
    provider: provider,
    model: model,
    size: size,
    count: count,
    unit: unit,
    cost: unit * count,
    pending: pendingPrice,
    pricingStatus: pricingStatus,
    pricingSource: pricingSource,
    momoQuotaType: provider === 'momo' ? momoQuotaType : undefined,
    momoKeyTag: provider === 'momo' ? _momoKeyTag() : undefined,
    // v6.5.0: 生成记录项目层的"本文档总开销"按这两个字段聚合
    docName: data.docName || '',
    docPath: data.docPath || ''
  };
  var l = _getLedger();
  l.push(entry);
  _saveLedger(l);
  // 通知打开中的面板刷新
  TileAPI.emit('billing:updated', { provider: provider });
  if (provider === 'momo' && pendingPrice) {
    _fetchMomoPricesOnce();
    _scheduleMomoBillingRefresh();
  }
}

// 汇总某算力的本地花费
function _summarize(provider) {
  var l = _getLedger();
  var todayStart = _todayStart();
  var allCost = 0, allImg = 0, allTask = 0;
  var todayCost = 0, todayImg = 0, todayTask = 0;
  for (var i = 0; i < l.length; i++) {
    var e = l[i];
    if (e.provider !== provider) continue;
    allCost += (+e.cost || 0); allImg += (+e.count || 0); allTask += 1;
    if (e.ts >= todayStart) { todayCost += (+e.cost || 0); todayImg += (+e.count || 0); todayTask += 1; }
  }
  return { allCost: allCost, allImg: allImg, allTask: allTask, todayCost: todayCost, todayImg: todayImg, todayTask: todayTask };
}

// ============================================================
//  渲染
// ============================================================
function _localCardHtml(provider) {
  var def = provider === 'aji' ? 'AJI' : provider === 'grs' ? (TileAPI.computeBrand ? TileAPI.computeBrand() : 'GRS') : '自定义渠道';
  var name = TileAPI.slotLabel ? TileAPI.slotLabel(provider, def) : def;
  var s = _summarize(provider);

  // 实时余额/积分(读现有数据源)
  var balHtml;
  if (provider === 'aji') {
    var bal = TileAPI.state.get('balance.current');
    balHtml = (bal == null || bal < 0) ? '<span class="bill-dim">尚未查询</span>' : '$' + (+bal).toFixed(4);
  } else if (provider === 'grs') {
    var cr = TileAPI.state.get('grs.credits');
    balHtml = (cr == null || cr < 0) ? '<span class="bill-dim">尚未查询</span>' : Math.round(cr).toLocaleString() + ' 分';
  } else {
    balHtml = '<span class="bill-dim">无实时接口</span>';
  }

  return '' +
    '<div class="bill-card" data-bill-prov="' + provider + '">' +
      '<div class="bill-card-head"><span class="bill-card-name">' + _esc(name) + '</span>' +
        '<span class="bill-card-bal">余额 ' + balHtml + '</span></div>' +
      '<div class="bill-grid">' +
        '<div class="bill-cell"><div class="bill-cell-v">' + _fmtMoney(provider, s.todayCost) + '</div><div class="bill-cell-l">今日花费</div></div>' +
        '<div class="bill-cell"><div class="bill-cell-v">' + s.todayImg + '</div><div class="bill-cell-l">今日出图</div></div>' +
        '<div class="bill-cell"><div class="bill-cell-v">' + _fmtMoney(provider, s.allCost) + '</div><div class="bill-cell-l">累计花费</div></div>' +
        '<div class="bill-cell"><div class="bill-cell-v">' + s.allImg + '</div><div class="bill-cell-l">累计出图</div></div>' +
      '</div>' +
    '</div>';
}

function _momoCardHtml() {
  var name = TileAPI.slotLabel ? TileAPI.slotLabel('momo', '墨墨') : '墨墨';
  var hasKey = !!(TileAPI.storage.get('connection.momo.key') || '');
  var body;
  if (!hasKey) {
    body = '<div class="bill-momo-empty">未配置墨墨 Key — 请到顶栏 ⚡算力配置 → 墨墨 填入 Key</div>';
  } else {
    body = '' +
      '<div class="bill-momo-tabs">' +
        '<button class="w10-btn bill-momo-tab w10-btn-accent" data-period="daily">今日</button>' +
        '<button class="w10-btn bill-momo-tab" data-period="weekly">本周</button>' +
        '<button class="w10-btn bill-momo-tab" data-period="monthly">本月</button>' +
        '<button class="w10-btn" id="billMomoRefresh">🔄 查询</button>' +
      '</div>' +
      '<div class="bill-grid" id="billMomoSummary">' +
        '<div class="bill-cell"><div class="bill-cell-v" id="billMomoCost">—</div><div class="bill-cell-l">总花费(美元)</div></div>' +
        '<div class="bill-cell"><div class="bill-cell-v" id="billMomoCount">—</div><div class="bill-cell-l">调用次数</div></div>' +
      '</div>' +
      '<div class="bill-momo-list" id="billMomoList"><div class="bill-dim" style="padding:8px;">点上面的「今日/本周/本月」查询消费明细</div></div>';
  }
  return '' +
    '<div class="bill-card bill-card-momo">' +
      '<div class="bill-card-head"><span class="bill-card-name">' + _esc(name) + '</span>' +
        '<span class="bill-card-bal" id="billMomoBal">' + (hasKey ? '余额 <span class="bill-dim">查询中…</span>' : '<span class="bill-dim">未配置</span>') + '</span></div>' +
      body +
    '</div>';
}

function _renderPanel(container) {
  // aji / grs 本地卡片(按可见顺序), 再 momo 在线卡片
  var localHtml = '';
  ['aji', 'grs'].forEach(function(p) { localHtml += _localCardHtml(p); });
  // others 若有花费也展示
  if (_summarize('others').allTask > 0) localHtml += _localCardHtml('others');

  container.innerHTML =
    '<div class="w10-panel bill-panel">' +
      '<div class="w10-section-title">💰 算力账单</div>' +
      '<div class="bill-intro">AJI / 夏算力按本地任务流水估算花费(以服务端余额为准);墨墨从在线接口查消费。</div>' +
      localHtml +
      _momoCardHtml() +
      '<div class="bill-actions">' +
        '<button class="w10-btn" id="billClear">清空本地流水</button>' +
        '<span class="bill-dim" id="billLedgerCount"></span>' +
      '</div>' +
    '</div>';

  _updateLedgerCount(container);
  _bindPanel(container);
  // 打开就查一次墨墨余额(有 Key 才查)
  if (TileAPI.storage.get('connection.momo.key')) _fetchMomoBalance(container);
}

function _updateLedgerCount(container) {
  var el = container.querySelector('#billLedgerCount');
  if (el) el.textContent = '本地流水 ' + _getLedger().length + ' 条';
}

function _bindPanel(container) {
  // 清空本地流水
  var clearBtn = container.querySelector('#billClear');
  if (clearBtn) clearBtn.addEventListener('click', function() {
    TileAPI.confirm('确定清空本地账单流水? (只清本地统计, 不影响真实余额/消费)').then(function(ok) {
      if (!ok) return;
      TileAPI.storage.set(LEDGER_KEY, []);
      _renderPanel(container);
      TileAPI.toast('已清空本地流水', 'success');
    });
  });

  // momo 周期 tab
  var tabs = container.querySelectorAll('.bill-momo-tab');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) { t.classList.remove('w10-btn-accent'); });
      tab.classList.add('w10-btn-accent');
      _fetchMomoBilling(container, tab.dataset.period);
    });
  });
  var refreshBtn = container.querySelector('#billMomoRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    var active = container.querySelector('.bill-momo-tab.w10-btn-accent');
    _fetchMomoBilling(container, (active && active.dataset.period) || 'daily');
    _fetchMomoBalance(container);
  });
}

// ============================================================
//  墨墨网络请求 — 统一走 host 转发(UXP 前端直接 fetch /api/* 会 failed to fetch)
//  余额: checkMomoQuota → /api/usage/token/ (owner_balance_usd 已是美元)
//  账单: momoBilling → /api/billing/token?period=...
//  按 requestId 关联请求与回包; 15s 超时兜底, 防 UI 卡在"查询中"
// ============================================================
var _momoReqSeq = 0;
var _momoQuotaCbs = {};
var _momoBillingCbs = {};
var _momoPricesCbs = {};
function _newMomoReqId() { _momoReqSeq++; return 'bill_' + Date.now() + '_' + _momoReqSeq; }
function _momoCall(map, action, extra, cb) {
  var key = (TileAPI.storage.get('connection.momo.key') || '').replace(/\s+/g, '');
  if (!key) { cb({ success: false, error: '未配置 Key' }); return; }
  var rid = _newMomoReqId();
  var done = false;
  map[rid] = function(d) { if (done) return; done = true; delete map[rid]; cb(d); };
  var payload = { requestId: rid, apiKey: key, apiBaseUrl: MOMO_BASE_URL };
  for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
  TileAPI.sendToHost(action, payload);
  setTimeout(function() { var fn = map[rid]; if (fn) { delete map[rid]; if (!done) { done = true; cb({ success: false, error: '查询超时' }); } } }, 15000);
}
TileAPI.onHostMessage('momoQuotaResult', function(d) { if (d && d.requestId && _momoQuotaCbs[d.requestId]) _momoQuotaCbs[d.requestId](d); });
TileAPI.onHostMessage('momoBillingResult', function(d) { if (d && d.requestId && _momoBillingCbs[d.requestId]) _momoBillingCbs[d.requestId](d); });
TileAPI.onHostMessage('momoPricesResult', function(d) { if (d && d.requestId && _momoPricesCbs[d.requestId]) _momoPricesCbs[d.requestId](d); });

function _parseMomoBilling(data) {
  var d = data || {};
  var quotaPerUsd = _finiteNumber(d.quota_per_unit);
  if (quotaPerUsd == null || quotaPerUsd <= 0) quotaPerUsd = MOMO_QUOTA_PER_USD;

  var totalQuota = _finiteNumber(d.total_quota);
  var totalCount = _finiteNumber(d.total_count);
  var breakdown = Array.isArray(d.breakdown) ? d.breakdown : [];
  var rows = [];
  var byModel = {};
  var summedQuota = 0;
  var summedCount = 0;

  for (var i = 0; i < breakdown.length; i++) {
    var bucket = breakdown[i] || {};
    var models = Array.isArray(bucket.models) ? bucket.models : [];
    for (var j = 0; j < models.length; j++) {
      var m = models[j] || {};
      var name = String(m.model_name || '').trim();
      if (!name) continue;
      var quota = _finiteNumber(m.quota);
      var count = _finiteNumber(m.count);
      var tokens = _finiteNumber(m.tokens);
      if (quota == null) quota = 0;
      if (count == null || count < 0) count = 0;
      if (tokens == null || tokens < 0) tokens = 0;
      rows.push({ date: bucket.date || '', model: name, quota: quota, count: count, tokens: tokens, cost: quota / quotaPerUsd });
      summedQuota += quota;
      summedCount += count;
      if (!byModel[name]) byModel[name] = { quota: 0, count: 0, tokens: 0 };
      byModel[name].quota += quota;
      byModel[name].count += count;
      byModel[name].tokens += tokens;
    }
  }

  Object.keys(byModel).forEach(function(name) {
    var m = byModel[name];
    m.avgCost = m.count > 0 ? (m.quota / m.count / quotaPerUsd) : null;
  });
  if (totalQuota == null) totalQuota = summedQuota;
  if (totalCount == null) totalCount = summedCount;
  return {
    period: d.period || '',
    totalQuota: totalQuota,
    totalCount: totalCount,
    totalCost: totalQuota / quotaPerUsd,
    quotaPerUsd: quotaPerUsd,
    rows: rows,
    byModel: byModel
  };
}

function _findParsedMomoModel(byModel, model) {
  if (Object.prototype.hasOwnProperty.call(byModel, model)) return byModel[model];
  var wanted = String(model || '').trim().toLowerCase();
  if (!wanted) return null;
  var found = null;
  var ambiguous = false;
  Object.keys(byModel).forEach(function(name) {
    if (String(name).trim().toLowerCase() !== wanted) return;
    if (found) ambiguous = true;
    else found = byModel[name];
  });
  return ambiguous ? null : found;
}

// 账单接口没有 requestId 级明细，只能按“今日同模型平均单次真实消耗”拆给本地项目。
function _reconcileMomoBilling(parsed, period) {
  if (!parsed || period !== 'daily') return false;
  var keyTag = _momoKeyTag();
  if (!keyTag) return false;
  var ledger = _getLedger();
  var todayStart = _todayStart();
  var changed = false;
  for (var i = 0; i < ledger.length; i++) {
    var e = ledger[i];
    if (!e || e.provider !== 'momo' || e.momoKeyTag !== keyTag || (+e.ts || 0) < todayStart) continue;
    if (e.pricingStatus !== 'pending' && e.pricingStatus !== 'billing-average') continue;
    var modelBill = _findParsedMomoModel(parsed.byModel || {}, e.model || '');
    if (!modelBill || modelBill.avgCost == null) continue;
    e.unit = modelBill.avgCost;
    e.cost = modelBill.avgCost * (+e.count || 0);
    e.pending = false;
    e.pricingStatus = 'billing-average';
    e.pricingSource = 'billing-daily-model-average';
    e.reconciledAt = Date.now();
    changed = true;
  }
  if (changed) {
    _saveLedger(ledger);
    TileAPI.emit('billing:updated', { provider: 'momo' });
  }
  return changed;
}

var _momoAutoBillingTimers = [];
var _momoAutoBillingInFlight = false;
var _momoAutoBillingQueued = false;
function _scheduleMomoBillingRefresh() {
  for (var i = 0; i < _momoAutoBillingTimers.length; i++) clearTimeout(_momoAutoBillingTimers[i]);
  _momoAutoBillingTimers = [];
  [3000, 10000, 30000].forEach(function(delay) {
    _momoAutoBillingTimers.push(setTimeout(_autoRefreshMomoBilling, delay));
  });
}
function _autoRefreshMomoBilling() {
  if (!_cleanMomoKey()) return;
  if (_momoAutoBillingInFlight) { _momoAutoBillingQueued = true; return; }
  _momoAutoBillingInFlight = true;
  _momoCall(_momoBillingCbs, 'momoBilling', { period: 'daily' }, function(resp) {
    _momoAutoBillingInFlight = false;
    if (resp && resp.success) _reconcileMomoBilling(_parseMomoBilling(resp.data || {}), 'daily');
    if (_momoAutoBillingQueued) {
      _momoAutoBillingQueued = false;
      setTimeout(_autoRefreshMomoBilling, 1000);
    }
  });
}

function _fetchMomoBalance(container) {
  var el = container.querySelector('#billMomoBal');
  if (!el) return;
  var key = (TileAPI.storage.get('connection.momo.key') || '').replace(/\s+/g, '');
  if (!key) { el.innerHTML = '<span class="bill-dim">未配置</span>'; return; }
  el.innerHTML = '余额 <span class="bill-dim">查询中…</span>';
  _momoCall(_momoQuotaCbs, 'checkMomoQuota', {}, function(d) {
    var el2 = container.querySelector('#billMomoBal');
    if (!el2) return;
    if (!d || !d.success) {
      el2.innerHTML = '余额 <span class="bill-dim">查询失败</span>';
      TileAPI.log('[billing] 墨墨余额: ' + ((d && d.error) || ''), 'warn');
      return;
    }
    if (d.unlimited_quota) { el2.innerHTML = '余额 无限'; return; }
    var usd = d.balance_usd;   // 只看令牌自身额度
    if (usd == null) { el2.innerHTML = '余额 <span class="bill-dim">—</span>'; return; }
    el2.innerHTML = '余额 $' + (+usd).toFixed(4);
  });
}

// ============================================================
//  墨墨在线账单: momoBilling → /api/billing/token?period=...
// ============================================================
function _fetchMomoBilling(container, period) {
  var key = (TileAPI.storage.get('connection.momo.key') || '').replace(/\s+/g, '');
  if (!key) { TileAPI.toast('请先在顶栏 ⚡算力配置 → 墨墨 填 Key', 'error'); return; }
  var listEl = container.querySelector('#billMomoList');
  if (listEl) listEl.innerHTML = '<div class="bill-dim" style="padding:8px;">查询中…</div>';

  _momoCall(_momoBillingCbs, 'momoBilling', { period: period || 'daily' }, function(resp) {
    var listEl2 = container.querySelector('#billMomoList');
    var costEl = container.querySelector('#billMomoCost');
    var countEl = container.querySelector('#billMomoCount');
    if (!resp || !resp.success) {
      if (listEl2) listEl2.innerHTML = '<div class="bill-dim" style="padding:8px;color:#ff7a7a;">查询失败: ' + _esc((resp && resp.error) || '') + '</div>';
      TileAPI.toast('墨墨账单查询失败: ' + ((resp && resp.error) || ''), 'error');
      return;
    }
    var requestedPeriod = period || 'daily';
    var parsed = _parseMomoBilling(resp.data || {});
    _reconcileMomoBilling(parsed, requestedPeriod);
    if (costEl) costEl.textContent = '$' + parsed.totalCost.toFixed(4);
    if (countEl) countEl.textContent = Math.round(parsed.totalCount).toLocaleString();
    if (!parsed.rows.length) {
      if (listEl2) listEl2.innerHTML = '<div class="bill-dim" style="padding:8px;">该时间段没有消费记录</div>';
      return;
    }
    var rows = parsed.rows.map(function(rec) {
      var usage = Math.round(rec.count).toLocaleString() + '次';
      if (rec.tokens > 0) usage += ' · ' + Math.round(rec.tokens).toLocaleString() + 'tk';
      return '<div class="bill-momo-row">' +
        '<span class="bill-momo-time">' + _esc(rec.date || '') + '</span>' +
        '<span class="bill-momo-model" title="' + _esc(rec.model) + '">' + _esc(rec.model) + '</span>' +
        '<span class="bill-momo-tokens">' + _esc(usage) + '</span>' +
        '<span class="bill-momo-fee">$' + rec.cost.toFixed(4) + '</span>' +
      '</div>';
    }).join('');
    if (listEl2) listEl2.innerHTML = rows;
  });
}

// ============================================================
//  磁贴注册
// ============================================================
function renderFront(container, w, h) {
  var s = _summarize('aji');
  var sub = '$' + s.todayCost.toFixed(2) + ' 今日';
  if (w >= 2) {
    container.innerHTML =
      '<div class="tile-icon">💰</div>' +
      '<div class="tile-label">算力账单</div>' +
      '<div class="tile-desc">' + _esc(sub) + '</div>';
  } else {
    container.innerHTML =
      '<div class="tile-icon">💰</div>' +
      '<div class="tile-label">账单</div>';
  }
}

var _liveContainers = [];

TileAPI.registerTile({
  id: 'billing',
  group: 'main',
  icon: '💰',
  label: '算力账单',
  desc: 'AJI/夏算力本地估算 · 墨墨在线查询',
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },
  maxSize: { w: 4, h: 8 },

  renderFront: renderFront,

  onExpand: function(container) {
    _fetchMomoPricesOnce();
    _renderPanel(container);
    _liveContainers.push(container);
    return function() {
      var i = _liveContainers.indexOf(container);
      if (i >= 0) _liveContainers.splice(i, 1);
    };
  }
});

// ============================================================
//  模块级常驻监听: 出图完成就记账(面板没开也记)
// ============================================================
TileAPI.on('generate:complete', _recordLedger);

// 流水更新 → 刷新打开中的面板(只刷本地卡片区, 简单起见整面板重渲)
TileAPI.on('billing:updated', function() {
  _liveContainers.forEach(function(c) {
    // 避免打断 momo 查询结果: 只更新本地卡片的数值, 这里简单重渲本地卡片
    ['aji', 'grs', 'others'].forEach(function(p) {
      var card = c.querySelector('.bill-card[data-bill-prov="' + p + '"]');
      if (card) {
        var tmp = document.createElement('div');
        tmp.innerHTML = _localCardHtml(p);
        if (tmp.firstChild) card.parentNode.replaceChild(tmp.firstChild, card);
      }
    });
    _updateLedgerCount(c);
  });
});

})();
