// 轮椅浏览器 — index.js（纯浏览器，无 IPC 监听）
var urlInput = document.getElementById('urlInput');
var browserView = document.getElementById('browserView');
var welcomePage = document.getElementById('welcomePage');
var loadingBar = document.getElementById('loadingBar');
var btnBack = document.getElementById('btnBack');
var btnForward = document.getElementById('btnForward');
var btnRefresh = document.getElementById('btnRefresh');
var btnGo = document.getElementById('btnGo');
var btnHome = document.getElementById('btnHome');
var zoomDisplay = document.getElementById('zoomDisplay');
var historyPanel = document.getElementById('historyPanel');
var historyList = document.getElementById('historyList');

var _navHistory = [];
var _navIdx = -1;
var _visitHistory = []; // 持久化的访问历史 [{url, title, time}]
var HIST_KEY = 'browser_visit_history';
var HIST_MAX = 50;

// ── URL 处理 ──
function normalizeUrl(input) {
    input = input.trim();
    if (!input) return '';
    if (/^https?:\/\//i.test(input)) return input;
    if (/^[a-zA-Z0-9]([a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}/.test(input)) return 'https://' + input;
    return 'https://www.baidu.com/s?wd=' + encodeURIComponent(input);
}

function getDisplayTitle(url) {
    try {
        var u = new URL(url);
        return u.hostname.replace(/^www\./, '');
    } catch(e) { return url.substring(0, 30); }
}

// ── 导航 ──
function navigate(url) {
    url = normalizeUrl(url);
    if (!url) return;

    urlInput.value = url;
    welcomePage.style.display = 'none';
    browserView.style.display = 'flex';
    loadingBar.classList.add('active');

    if (_navIdx < _navHistory.length - 1) {
        _navHistory = _navHistory.slice(0, _navIdx + 1);
    }
    _navHistory.push(url);
    _navIdx = _navHistory.length - 1;
    updateNavBtns();
    addToVisitHistory(url);

    browserView.src = url;
    setTimeout(function() { loadingBar.classList.remove('active'); }, 3000);
}

function goBack() {
    if (_navIdx <= 0) return;
    _navIdx--;
    var url = _navHistory[_navIdx];
    urlInput.value = url;
    browserView.src = url;
    loadingBar.classList.add('active');
    setTimeout(function() { loadingBar.classList.remove('active'); }, 3000);
    updateNavBtns();
}

function goForward() {
    if (_navIdx >= _navHistory.length - 1) return;
    _navIdx++;
    var url = _navHistory[_navIdx];
    urlInput.value = url;
    browserView.src = url;
    loadingBar.classList.add('active');
    setTimeout(function() { loadingBar.classList.remove('active'); }, 3000);
    updateNavBtns();
}

function refresh() {
    if (_navHistory.length > 0) {
        var url = _navHistory[_navIdx];
        browserView.src = '';
        loadingBar.classList.add('active');
        setTimeout(function() { browserView.src = url; }, 50);
        setTimeout(function() { loadingBar.classList.remove('active'); }, 3000);
    }
}

function goHome() {
    welcomePage.style.display = 'flex';
    browserView.style.display = 'none';
    browserView.src = '';
    urlInput.value = '';
    loadingBar.classList.remove('active');
}

function updateNavBtns() {
    btnBack.disabled = _navIdx <= 0;
    btnForward.disabled = _navIdx >= _navHistory.length - 1;
}

// ── 访问历史 ──
function loadVisitHistory() {
    try {
        var raw = localStorage.getItem(HIST_KEY);
        if (raw) _visitHistory = JSON.parse(raw);
    } catch(e) { _visitHistory = []; }
}

function saveVisitHistory() {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(_visitHistory)); } catch(e) {}
}

function addToVisitHistory(url) {
    // 去重：如果最近一条就是同一个 URL 就不重复加
    if (_visitHistory.length > 0 && _visitHistory[0].url === url) return;
    _visitHistory.unshift({
        url: url,
        title: getDisplayTitle(url),
        time: new Date().toLocaleTimeString()
    });
    if (_visitHistory.length > HIST_MAX) _visitHistory = _visitHistory.slice(0, HIST_MAX);
    saveVisitHistory();
}

function renderHistoryList() {
    historyList.innerHTML = '';
    if (_visitHistory.length === 0) {
        historyList.innerHTML = '<div class="hist-empty">暂无历史记录</div>';
        return;
    }
    _visitHistory.forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'hist-item';
        el.textContent = item.time + '  ' + item.title + '  ' + item.url;
        el.title = item.url;
        el.addEventListener('click', function() {
            navigate(item.url);
            historyPanel.classList.remove('show');
        });
        historyList.appendChild(el);
    });
}

// ── 事件绑定 ──
btnGo.addEventListener('click', function() { navigate(urlInput.value); });
btnBack.addEventListener('click', goBack);
btnForward.addEventListener('click', goForward);
btnRefresh.addEventListener('click', refresh);
btnHome.addEventListener('click', goHome);
urlInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') navigate(urlInput.value); });

// ── 书签(默认内置, 主插件可通过 IPC 配置覆盖) ──
var DEFAULT_BOOKMARKS = [
    { name: 'Pinterest', url: 'https://www.pinterest.com/' },
    { name: '抖音搜索', url: 'https://www.douyin.com/search/' },
    { name: 'ArtStation', url: 'https://www.artstation.com/' },
    { name: 'Civitai', url: 'https://civitai.com' },
    { name: 'HuggingFace', url: 'https://huggingface.co' },
    { name: '百度', url: 'https://www.baidu.com' },
    { name: 'Google', url: 'https://www.google.com' }
];
var _bmSig = '';   // 当前书签签名, 用于判断配置变了才重渲
function renderBookmarks(list) {
    var bar = document.getElementById('bookmarks');
    var anchor = document.getElementById('btnHistory'); // 书签插在「历史」按钮前
    if (!bar || !anchor) return;
    if (!list || !list.length) list = DEFAULT_BOOKMARKS;
    var sig = JSON.stringify(list);
    if (sig === _bmSig) return; // 没变, 不重渲
    _bmSig = sig;
    // 清掉旧的动态书签 (带 data-dyn-bm 标记的), 保留 历史/图片→PS
    var olds = bar.querySelectorAll('[data-dyn-bm]');
    for (var i = 0; i < olds.length; i++) olds[i].parentNode.removeChild(olds[i]);
    // 按顺序把书签按钮插在 anchor 前 (= 直接成为 #bookmarks 的 flex 子项, 横向滚动)
    list.forEach(function(bm) {
        if (!bm || !bm.url) return;
        var btn = document.createElement('button');
        btn.className = 'bm-btn';
        btn.setAttribute('data-dyn-bm', '1');
        btn.textContent = bm.name || bm.url;
        btn.title = bm.url;
        btn.addEventListener('click', function() { navigate(bm.url); });
        bar.insertBefore(btn, anchor);
    });
}
renderBookmarks(DEFAULT_BOOKMARKS);

// 历史按钮
document.getElementById('btnHistory').addEventListener('click', function(e) {
    e.stopPropagation();
    renderHistoryList();
    historyPanel.classList.toggle('show');
});
document.getElementById('btnClearHistory').addEventListener('click', function() {
    _visitHistory = [];
    saveVisitHistory();
    renderHistoryList();
});
// 点击外部关闭历史面板
document.addEventListener('click', function(e) {
    if (!historyPanel.contains(e.target) && e.target.id !== 'btnHistory') {
        historyPanel.classList.remove('show');
    }
});

// ── Ctrl+滚轮缩放 ──
var _zoomLevel = 100;
var _zoomMin = 25;
var _zoomMax = 300;
var _zoomStep = 10;

function applyZoom() {
    var scale = _zoomLevel / 100;
    browserView.style.transform = 'scale(' + scale + ')';
    browserView.style.transformOrigin = '0 0';
    browserView.style.width = (100 / scale) + '%';
    browserView.style.height = (100 / scale) + '%';
    if (zoomDisplay) zoomDisplay.textContent = _zoomLevel + '%';
}

document.addEventListener('wheel', function(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    _zoomLevel = e.deltaY < 0 ? Math.min(_zoomMax, _zoomLevel + _zoomStep) : Math.max(_zoomMin, _zoomLevel - _zoomStep);
    applyZoom();
}, { passive: false });

document.addEventListener('keydown', function(e) {
    if (!e.ctrlKey) return;
    if (e.key === '0') { e.preventDefault(); _zoomLevel = 100; applyZoom(); }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); _zoomLevel = Math.min(_zoomMax, _zoomLevel + _zoomStep); applyZoom(); }
    if (e.key === '-') { e.preventDefault(); _zoomLevel = Math.max(_zoomMin, _zoomLevel - _zoomStep); applyZoom(); }
});

if (zoomDisplay) zoomDisplay.addEventListener('click', function() { _zoomLevel = 100; applyZoom(); });

// ── 初始化 ──
loadVisitHistory();

// ── 抓图功能：下载网页图片 → 放置到 PS ──
var grabPanel = document.getElementById('grabPanel');
var grabUrlInput = document.getElementById('grabUrlInput');
var grabPreview = document.getElementById('grabPreview');
var grabStatus = document.getElementById('grabStatus');
var _grabbing = false;

document.getElementById('btnGrabImage').addEventListener('click', function(e) {
    e.stopPropagation();
    grabPanel.classList.toggle('show');
    historyPanel.classList.remove('show');
});

document.getElementById('btnGrabPaste').addEventListener('click', async function() {
    try {
        // UXP 环境下尝试读取剪贴板
        if (navigator.clipboard && navigator.clipboard.readText) {
            var text = await navigator.clipboard.readText();
            if (text) grabUrlInput.value = text.trim();
        }
    } catch(e) {
        grabStatus.textContent = '无法读取剪贴板，请手动粘贴';
    }
    // 粘贴后尝试预览
    previewGrabImage();
});

grabUrlInput.addEventListener('input', function() {
    // 延迟预览
    clearTimeout(grabUrlInput._previewTimer);
    grabUrlInput._previewTimer = setTimeout(previewGrabImage, 500);
});

grabUrlInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('btnGrabGo').click();
});

function previewGrabImage() {
    var url = grabUrlInput.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
        grabPreview.innerHTML = '';
        return;
    }
    grabPreview.innerHTML = '<img src="' + url.replace(/"/g, '&quot;') + '" onerror="this.parentNode.innerHTML=\'预览失败\'" />';
}

document.getElementById('btnGrabGo').addEventListener('click', async function() {
    var url = grabUrlInput.value.trim();
    if (!url) { grabStatus.textContent = '请输入图片URL'; return; }
    if (_grabbing) return;
    _grabbing = true;
    var goBtn = document.getElementById('btnGrabGo');
    goBtn.disabled = true;
    grabStatus.textContent = '⏳ 正在下载图片...';

    try {
        // 下载图片
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var blob = await resp.blob();
        grabStatus.textContent = '⏳ 正在转换...';

        // Blob → Base64
        var base64 = await new Promise(function(resolve, reject) {
            var reader = new FileReader();
            reader.onload = function() {
                var dataUrl = reader.result;
                var b64 = dataUrl.split(',')[1];
                resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        grabStatus.textContent = '⏳ 正在导入PS...';

        // 通过 PS API 放置图片
        var app = require('photoshop').app;
        var core = require('photoshop').core;
        var imaging = require('photoshop').imaging;
        var fs = require('uxp').storage.localFileSystem;

        // 先保存为临时文件，再用 placeEvent 放入
        var tempFolder = await fs.getTemporaryFolder();
        var tempFile;
        try { tempFile = await tempFolder.getEntry('_browser_grab.png'); } catch(e) { tempFile = await tempFolder.createFile('_browser_grab.png'); }

        // base64 → 二进制写入临时文件
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await tempFile.write(bytes.buffer);

        // 用 batchPlay 放置到当前文档
        await core.executeAsModal(async function() {
            var doc = app.activeDocument;
            if (!doc) throw new Error('没有打开的文档');
            var token = await fs.createSessionToken(tempFile);
            await app.batchPlay([{
                _obj: "placeEvent",
                null: { _path: token, _kind: "local" },
                freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
                offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } }
            }], {});
            // 居中并适应画布
            await app.batchPlay([{
                _obj: "transform",
                freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" }
            }], {});
        }, { commandName: "浏览器导入图片" });

        grabStatus.textContent = '✅ 已导入PS！';
        grabStatus.style.color = '#69f0ae';
        setTimeout(function() { grabStatus.textContent = ''; grabStatus.style.color = ''; }, 3000);

    } catch(e) {
        grabStatus.textContent = '❌ ' + (e.message || '导入失败');
        grabStatus.style.color = '#ff8a80';
        setTimeout(function() { grabStatus.textContent = ''; grabStatus.style.color = ''; }, 5000);
    } finally {
        _grabbing = false;
        goBtn.disabled = false;
    }
});

// 点击外部关闭抓图面板
document.addEventListener('click', function(e) {
    if (!grabPanel.contains(e.target) && e.target.id !== 'btnGrabImage') {
        grabPanel.classList.remove('show');
    }
});

// ============================================================
// ── 任务锁：主插件没在跑任务时冻结浏览器 ──
//   原理跟「卫星」一致：主插件每 200ms 往 临时目录/wheelchair_ipc/state.json
//   写任务状态。state.tasks 非空 = 正在跑任务。
//   找主插件目录的办法：拿浏览器自己的临时目录路径，把里面浏览器的插件 ID
//   换成主插件 ID（两个插件的临时目录是挨着的兄弟文件夹）。
//   找不到 / 读不到 → 当作"没任务" → 保持冻结。
// ============================================================
(function setupTaskLock() {
    var BROWSER_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.browser';
    var MAIN_PLUGIN_ID = 'com.xiasanqi.ps.wheelchair.v4';
    var POLL_MS = 700;      // 多久看一次主插件状态
    var GRACE_MS = 4000;    // 任务消失后，宽限几秒再冻结（避免两个任务之间一闪一冻）

    var _uxpFS = null;
    try { _uxpFS = require('uxp').storage.localFileSystem; } catch (e) {}

    var _ipcDir = null;
    var _ipcResolved = false;   // 是否成功定位到主插件目录
    var _freezeTimer = null;    // 宽限计时器
    var _frozen = null;         // 当前冻结状态（null=未初始化）
    var _idleLock = true;       // 寸止开关: true=没任务时冻结(默认); false=主插件配置关掉了, 自由浏览

    // —— 遮罩 ——
    var overlay = document.createElement('div');
    overlay.id = 'taskLockOverlay';
    overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
        'width:100%', 'height:100%', 'z-index:99999',
        'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'background:rgba(20,20,22,0.92)',
        'backdrop-filter:blur(3px)',
        '-webkit-backdrop-filter:blur(3px)',
        'color:#e0e0e0', 'text-align:center',
        'font-family:-apple-system,"Segoe UI",sans-serif',
        'user-select:none', 'cursor:not-allowed',
        'transition:opacity 0.25s'
    ].join(';');
    overlay.innerHTML =
        '<div style="font-size:40px;margin-bottom:12px;">🔒</div>' +
        '<div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;">主插件没在跑任务</div>' +
        '<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.7;max-width:240px;">' +
            '去主插件点生成图片，<br>等待出图的时候，这里才能玩浏览器。' +
        '</div>' +
        '<div id="taskLockStatus" style="margin-top:16px;font-size:9px;color:rgba(255,255,255,0.28);"></div>';
    // 吞掉遮罩上的所有交互，别让点击穿到下面的浏览器/按钮
    ['click', 'mousedown', 'mouseup', 'wheel', 'keydown', 'contextmenu'].forEach(function (ev) {
        overlay.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); }, true);
    });
    var _statusEl = null;
    function _setStatus(txt) {
        if (!_statusEl) _statusEl = document.getElementById('taskLockStatus');
        if (_statusEl) _statusEl.textContent = txt || '';
    }
    document.body.appendChild(overlay);

    // UXP 的 <webview> 是原生层，永远画在 HTML 之上，HTML 遮罩盖不住它。
    // 但 display:none 会让原生层销毁重建 → 恢复时网页重新加载。
    // 所以冻结时不藏不销毁，只把 webview 挪到屏幕外（元素还活着、src 没动 = 不刷新），
    // 它跑出可视区就不会再盖住遮罩；解锁时再挪回原位。
    var _bv = document.getElementById('browserView');
    var _bvShownBeforeFreeze = false;

    function _hideWebview() {
        if (!_bv) return;
        _bv.style.position = 'fixed';
        _bv.style.left = '-100000px';
        _bv.style.top = '0';
        _bv.style.width = '50px';
        _bv.style.height = '50px';
    }
    function _showWebview() {
        if (!_bv) return;
        // 清掉挪走时加的内联样式，回到 CSS 里的 flex:1 布局
        _bv.style.position = '';
        _bv.style.left = '';
        _bv.style.top = '';
        _bv.style.width = '';
        _bv.style.height = '';
    }

    function applyFreeze(frozen, reason) {
        if (frozen === _frozen) { if (reason) _setStatus(reason); return; }
        _frozen = frozen;
        if (frozen) {
            // 记住当前 webview 是不是显示着，然后挪到屏幕外
            if (_bv) {
                _bvShownBeforeFreeze = (_bv.style.display !== 'none' && _bv.style.display !== '');
                if (_bvShownBeforeFreeze) _hideWebview();
            }
        } else {
            // 解锁：把 webview 挪回原位（网页一直没刷新）
            if (_bv && _bvShownBeforeFreeze) _showWebview();
        }
        overlay.style.display = frozen ? 'flex' : 'none';
        _setStatus(reason || '');
        console.log('[任务锁] ' + (frozen ? '冻结' : '解锁') + (reason ? ' — ' + reason : ''));
    }

    // 定位主插件的 IPC 目录
    async function getMainIPCDir() {
        if (_ipcDir) return _ipcDir;
        if (!_uxpFS) return null;
        try {
            var tempFolder = await _uxpFS.getTemporaryFolder();
            var myPath = tempFolder.nativePath || '';
            var mainPath = myPath.replace(BROWSER_PLUGIN_ID, MAIN_PLUGIN_ID);
            if (mainPath === myPath) {
                console.warn('[任务锁] 路径里没找到浏览器自己的 ID，无法推算主插件目录');
                return null;
            }
            var mainUrl = 'file:' + mainPath.replace(/\\/g, '/');
            var mainFolder = await _uxpFS.getEntryWithUrl(mainUrl);
            _ipcDir = await mainFolder.getEntry('wheelchair_ipc');
            _ipcResolved = true;
            console.log('[任务锁] 已定位主插件 IPC: ' + (_ipcDir.nativePath || '?'));
            return _ipcDir;
        } catch (e) {
            console.warn('[任务锁] 定位主插件目录失败: ' + e.message);
            return null;
        }
    }

    async function readState() {
        try {
            var dir = await getMainIPCDir();
            if (!dir) return { ok: false, reason: 'nodir' };
            var file = await dir.getEntry('state.json');
            var text = await file.read();
            if (!text || text.length < 3) return { ok: true, tasks: 0 };
            var s = JSON.parse(text);
            var n = (s && s.tasks) ? Object.keys(s.tasks).length : 0;
            return { ok: true, tasks: n };
        } catch (e) {
            // state.json 还没被主插件创建，或读失败
            return { ok: false, reason: 'noread' };
        }
    }

    // 读主插件下发的浏览器配置 (书签 + 寸止开关), 跟 state.json 同目录
    async function readBrowserConfig() {
        try {
            var dir = await getMainIPCDir();
            if (!dir) return;
            var file = await dir.getEntry('browser_config.json');
            var text = await file.read();
            if (!text || text.length < 2) return;
            var c = JSON.parse(text);
            // 书签: 配置里有就用配置, 没有保持默认
            if (c && c.bookmarks && c.bookmarks.length) renderBookmarks(c.bookmarks);
            // 寸止开关: 显式 false 才关闭, 其它(true/缺省)都视为开
            _idleLock = (c && c.idleLock === false) ? false : true;
        } catch (e) {
            // 没有配置文件 → 保持默认(寸止开 + 内置书签)
        }
    }

    function scheduleFreeze(reason) {
        if (_freezeTimer) return; // 已经在倒计时
        _freezeTimer = setTimeout(function () {
            _freezeTimer = null;
            applyFreeze(true, reason);
        }, GRACE_MS);
    }
    function cancelFreezeCountdown() {
        if (_freezeTimer) { clearTimeout(_freezeTimer); _freezeTimer = null; }
    }

    async function poll() {
        // 先同步主插件配置(书签 + 寸止开关)
        await readBrowserConfig();
        // 寸止关闭 → 永不冻结, 自由浏览(不管有没有任务)
        if (_idleLock === false) {
            cancelFreezeCountdown();
            applyFreeze(false, '寸止已关闭, 自由浏览');
            return;
        }
        var r = await readState();
        if (r.ok && r.tasks > 0) {
            // 有任务 → 立刻解锁
            cancelFreezeCountdown();
            applyFreeze(false, '主插件有 ' + r.tasks + ' 个任务进行中');
        } else if (r.ok && r.tasks === 0) {
            // 主插件在线但没任务 → 宽限后冻结
            if (!_frozen) scheduleFreeze('当前没有任务');
            else applyFreeze(true, '当前没有任务');
        } else {
            // 读不到主插件状态 → 冻结（并提示，方便排查）
            cancelFreezeCountdown();
            var hint = _ipcResolved ? '等待主插件…(主插件可能没打开)'
                                    : '没连上主插件(主插件没打开 / 检测不可用)';
            applyFreeze(true, hint);
        }
    }

    // 初始：先冻结，等第一次轮询出结果
    applyFreeze(true, '正在检测主插件…');
    poll();
    setInterval(poll, POLL_MS);
})();

// ── entrypoints ──
try {
    var ep = require('uxp').entrypoints;
    if (ep && ep.setup) {
        ep.setup({
            panels: {
                browserPanel: {
                    create: function() {},
                    show: function() {},
                    hide: function() {},
                    destroy: function() {}
                }
            }
        });
    }
} catch(e) {}
