// ============================================================
//  tile-canvas-gen.host.js
//  接受独立插件(轮椅幕布 canvas-pkg)委托生成图片。
//
//  零侵入: 由 host/tile-host-loader.js 自动 require,
//  自注册 action, 不改任何现有文件。
//
//  IPC 契约(与 canvas-pkg/cv-gen.js 对应, 已固定不许改):
//    读  wheelchair_ipc/canvas_gen_cmd/<genId>.json    请求
//    读  wheelchair_ipc/canvas_gen_in/<refImg>.png     输入图(二进制)
//    写  wheelchair_ipc/canvas_gen_out/<genId>_0.png   结果图(二进制)
//    写  wheelchair_ipc/canvas_gen_out/<genId>.result.json  结果状态
//
//  启动方式: 面板 tile-canvas-gen.js 加载后 sendToHost('cvGenBootstrap'),
//  借 ctx 拿 sendToPanel, 启动自轮询。
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxp = require('uxp');
var fs = uxp.storage.localFileSystem;
var formats = uxp.storage.formats;

var psPixels = require('../host/ps-pixels.js');
var base64ToArrayBuffer = psPixels.base64ToArrayBuffer;
var arrayBufferToBase64 = psPixels.arrayBufferToBase64;

var CMD_DIR = 'canvas_gen_cmd';
var IN_DIR  = 'canvas_gen_in';
var OUT_DIR = 'canvas_gen_out';
var POLL_MS = 400;

var _ipcFolder = null;
var _sendToPanel = null;
var _started = false;
var _polling = false;          // 防 async 重入
var _processed = {};           // genId -> true, 防同一请求重复消费 (备用, 主要靠删文件)

// ---- IPC 目录 ----

async function _getIpcFolder() {
    if (_ipcFolder) return _ipcFolder;
    var tempFolder = await fs.getTemporaryFolder();
    try { _ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
    catch (e) { _ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
    return _ipcFolder;
}

async function _ensureSubDir(name) {
    var ipc = await _getIpcFolder();
    try { return await ipc.getEntry(name); }
    catch (e) { return await ipc.createFolder(name); }
}

// ---- 原子写文件 (.writing -> rename) ----

async function _atomicWriteBinary(folder, fileName, arrayBuffer) {
    var tmpName = fileName + '.writing';
    var tmp = await folder.createFile(tmpName, { overwrite: true });
    await tmp.write(arrayBuffer);
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    try { await tmp.rename(fileName); }
    catch (e) {
        // rename 失败兜底: 直接写目标
        var f = await folder.createFile(fileName, { overwrite: true });
        await f.write(arrayBuffer);
    }
}

async function _atomicWriteText(folder, fileName, text) {
    var tmpName = fileName + '.writing';
    var tmp = await folder.createFile(tmpName, { overwrite: true });
    await tmp.write(text);
    try { var old = await folder.getEntry(fileName); await old.delete(); } catch (_) {}
    try { await tmp.rename(fileName); }
    catch (e) {
        var f = await folder.createFile(fileName, { overwrite: true });
        await f.write(text);
    }
}

// ---- 轮询扫描 ----

async function _poll() {
    if (_polling) return;
    _polling = true;
    try {
        var cmdDir;
        try { cmdDir = await _ensureSubDir(CMD_DIR); } catch (e) { return; }
        var entries;
        try { entries = await cmdDir.getEntries(); } catch (e) { return; }

        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry.isFile) continue;
            var name = entry.name || '';
            // 只处理 <genId>.json, 跳过 .writing 临时文件
            if (!/\.json$/i.test(name) || /\.writing$/i.test(name)) continue;

            var genId = name.replace(/\.json$/i, '');
            if (_processed[genId]) {
                // 已处理过, 尝试删除残留
                try { await entry.delete(); } catch (_) {}
                continue;
            }

            var text;
            try { text = await entry.read(); } catch (e) { continue; }
            if (!text || !text.trim()) continue;

            var cmd;
            try { cmd = JSON.parse(text); } catch (e) { continue; }  // 半截 JSON, 下次再读
            if (!cmd || !cmd.reqId) continue;

            // 标记 + 删除命令文件(消费掉)
            _processed[genId] = true;
            try { await entry.delete(); } catch (_) {}

            // 异步处理, 不阻塞下一个文件的扫描
            _handleRequest(cmd).catch(function(e) {
                try { console.warn('[cvGen] handleRequest 异常: ' + ((e && e.message) || e)); } catch (_) {}
            });
        }
    } catch (e) {
        try { console.warn('[cvGen] poll 异常: ' + ((e && e.message) || e)); } catch (_) {}
    } finally {
        _polling = false;
    }
}

// ---- 处理单条请求 ----

async function _handleRequest(cmd) {
    var reqId = cmd.reqId;
    var data = cmd.data || {};

    // 读输入图: refImages 里列的每个文件名 → base64
    var images = [];
    var refImages = data.refImages || [];
    if (refImages.length) {
        var inDir;
        try { inDir = await _ensureSubDir(IN_DIR); } catch (e) {}
        for (var j = 0; j < refImages.length; j++) {
            var imgName = refImages[j];
            if (!imgName) continue;
            try {
                var imgEntry = await inDir.getEntry(imgName);
                var buf = await imgEntry.read({ format: formats.binary });
                images.push(arrayBufferToBase64(buf));
            } catch (e) {
                try { console.warn('[cvGen] 读输入图失败 ' + imgName + ': ' + ((e && e.message) || e)); } catch (_) {}
            }
            // 读完就删(不阻塞, 删失败无所谓)
            try { var delEntry = await inDir.getEntry(imgName); await delEntry.delete(); } catch (_) {}
        }
    }

    // 转给前端, 由前端拿 API key 后调 canvasGenerate
    if (_sendToPanel) {
        _sendToPanel('cvGenResolveAndRun', {
            reqId: reqId,
            prompt: data.prompt || '',
            images: images,
            provider: data.provider || '',
            model: data.model || '',
            size: data.size || '',
            aspectRatio: data.aspectRatio || '',
            timeout: data.timeout || 3600
        });
    } else {
        // 面板未就绪, 直接写失败
        await _writeFailResult(reqId, '主插件面板未就绪, 无法处理生成请求');
    }
}

// ---- 写结果(由前端回调触发) ----

async function _writeSuccessResult(reqId, base64) {
    try {
        var outDir = await _ensureSubDir(OUT_DIR);
        // 先写结果图
        var imgName = reqId + '_0.png';
        await _atomicWriteBinary(outDir, imgName, base64ToArrayBuffer(base64));
        // 再写 result.json(幕布轮询这个文件)
        var resultJson = JSON.stringify({
            reqId: reqId,
            success: true,
            data: { results: [imgName] }
        });
        await _atomicWriteText(outDir, reqId + '.result.json', resultJson);
    } catch (e) {
        try { console.warn('[cvGen] writeSuccessResult 失败: ' + ((e && e.message) || e)); } catch (_) {}
    }
}

async function _writeFailResult(reqId, error) {
    try {
        var outDir = await _ensureSubDir(OUT_DIR);
        var resultJson = JSON.stringify({
            reqId: reqId,
            success: false,
            error: error || 'unknown error',
            data: { results: [] }
        });
        await _atomicWriteText(outDir, reqId + '.result.json', resultJson);
    } catch (e) {
        try { console.warn('[cvGen] writeFailResult 失败: ' + ((e && e.message) || e)); } catch (_) {}
    }
}

// ============================================================
//  cvGenBootstrap — 面板加载后调一次, 借 ctx 拿 sendToPanel + 启动自轮询
// ============================================================
HostAPI.registerAction('cvGenBootstrap', async function(data, ctx) {
    try {
        if (ctx && ctx.sendToPanel) _sendToPanel = ctx.sendToPanel;
        if (!_started) {
            _started = true;
            await _getIpcFolder();
            await _ensureSubDir(CMD_DIR);
            await _ensureSubDir(IN_DIR);
            await _ensureSubDir(OUT_DIR);
            setInterval(function() { _poll(); }, POLL_MS);
            try { console.log('[cvGen] 已启动自轮询 (' + POLL_MS + 'ms)'); } catch (_) {}
        }
        if (ctx && ctx.sendToPanel) ctx.sendToPanel('cvGenReady', { ok: true });
    } catch (e) {
        try { console.warn('[cvGen] bootstrap 失败: ' + ((e && e.message) || e)); } catch (_) {}
    }
    return true;
}, { tileId: 'canvas-gen' });

// ============================================================
//  cvGenWriteResult — 前端处理完生成后回调, 由 host 写 result 文件
//  data: { reqId, success, base64?, error? }
// ============================================================
HostAPI.registerAction('cvGenWriteResult', async function(data, ctx) {
    if (!data || !data.reqId) return;
    if (data.success && data.base64) {
        await _writeSuccessResult(data.reqId, data.base64);
    } else {
        await _writeFailResult(data.reqId, data.error || '生成失败');
    }
    return true;
}, { tileId: 'canvas-gen' });

module.exports = {};
