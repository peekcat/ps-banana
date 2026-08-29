// ============================================================
//  tile-browser.host.js
//  「轮椅浏览器」独立插件的安装/状态/配置后端处理器
//  通过 HostAPI.registerAction 注册到路由表 (启动时被 tile-host-loader 自动 require)
//
//  机制完全仿照卫星 (host/bootstrap-handlers.js 的 satellite 三件套):
//    checkBrowserStatus  — 查 PS Plug-ins\轮椅浏览器\manifest.json 是否存在+版本
//    installBrowser      — 释放内置 browser-pkg.zip + bat 到 dataFolder, 提权解压
//    openBrowserFolder   — 打开安装目录
//    ipcWriteBrowserConfig — 写 wheelchair_ipc/browser_config.json (书签+寸止), 浏览器侧轮询读
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;
var formats = storage.formats;

// 内置浏览器包版本 — 必须跟 轮椅浏览器/manifest.json 的 version 同步, 否则升级判断不准
var BROWSER_LATEST_VERSION = '1.0.1';
var BROWSER_DIR_NAME = '轮椅浏览器';

// 推算 PS Plug-ins 目录 (主插件父目录) + 浏览器目标目录
async function _resolveDirs() {
    var pluginFolder = await fs.getPluginFolder();
    var pluginPath = (pluginFolder.nativePath || '').replace(/[\/\\]+$/, '').replace(/\//g, '\\');
    var idx = pluginPath.lastIndexOf('\\');
    var pluginsDir = idx > 0 ? pluginPath.substring(0, idx) : pluginPath;
    return {
        pluginFolder: pluginFolder,
        pluginsDir: pluginsDir,
        targetDir: pluginsDir + '\\' + BROWSER_DIR_NAME
    };
}

// ============================================================
//  checkBrowserStatus
// ============================================================
HostAPI.registerAction('checkBrowserStatus', async function(data, ctx) {
    try {
        var dirs = await _resolveDirs();
        var installed = false;
        var installedVersion = null;
        try {
            var url = 'file:' + dirs.targetDir.replace(/\\/g, '/') + '/manifest.json';
            var entry = await fs.getEntryWithUrl(url);
            var text = await entry.read();
            var mf = JSON.parse(text);
            installed = true;
            installedVersion = mf.version || '?';
        } catch (e) { /* 没装 */ }

        ctx.sendToPanel('browserStatus', {
            installed: installed,
            installedVersion: installedVersion,
            latestVersion: BROWSER_LATEST_VERSION,
            targetDir: dirs.targetDir,
            pluginsDir: dirs.pluginsDir
        });
    } catch (e) {
        ctx.sendToPanel('browserStatus', { installed: false, error: e.message });
    }
}, { tileId: 'browser' });

// ============================================================
//  installBrowser
// ============================================================
HostAPI.registerAction('installBrowser', async function(data, ctx) {
    try {
        var dirs = await _resolveDirs();
        var dataFolder = await fs.getDataFolder();

        // 1. 拷贝内置 browser-pkg.zip → dataFolder (跨目录读不支持直接拷, 需 read+write)
        var srcZip = await dirs.pluginFolder.getEntry('browser-pkg.zip');
        var srcBuf = await srcZip.read({ format: formats.binary });
        var dstZip = await dataFolder.createFile('browser-pkg.zip', { overwrite: true });
        await dstZip.write(srcBuf, { format: formats.binary });
        var zipPath = dstZip.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');

        // 2. 写安装配置 json
        var configJson = JSON.stringify({ zipPath: zipPath, targetDir: dirs.targetDir });
        var configFile = await dataFolder.createFile('browser_install_config.json', { overwrite: true });
        await configFile.write(configJson);

        // 3. 拷贝 install_browser.bat → dataFolder (插件目录可能只读)
        var srcBat = await dirs.pluginFolder.getEntry('install_browser.bat');
        var srcBatContent = await srcBat.read();
        var dstBat = await dataFolder.createFile('install_browser.bat', { overwrite: true });
        await dstBat.write(srcBatContent);
        var batPath = dataFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\') + '\\install_browser.bat';

        // 4. 调起 bat
        var shell = uxpModule.shell;
        if (shell && shell.openPath) {
            await shell.openPath(batPath, '即将安装/升级「轮椅浏览器」。点击允许后, 请先关闭 Photoshop。');
        } else if (shell && shell.openExternal) {
            await shell.openExternal('file:///' + batPath.replace(/\\/g, '/'));
        }

        ctx.sendToPanel('browserInstallStarted', { batPath: batPath, targetDir: dirs.targetDir });
        ctx.logToPanel('[浏览器] 安装脚本已启动: ' + batPath, 'success');
    } catch (e) {
        ctx.sendToPanel('browserInstallError', { error: e.message });
        ctx.logToPanel('[浏览器] 安装失败: ' + e.message, 'error');
    }
}, { tileId: 'browser' });

// ============================================================
//  openBrowserFolder
// ============================================================
HostAPI.registerAction('openBrowserFolder', async function(data, ctx) {
    try {
        var dirs = await _resolveDirs();
        var shell = uxpModule.shell;
        if (shell && shell.openPath) {
            await shell.openPath(dirs.targetDir);
        }
    } catch (e) {
        ctx.logToPanel('[浏览器] 打开目录失败: ' + e.message, 'error');
    }
}, { tileId: 'browser' });

// ============================================================
//  ipcWriteBrowserConfig — 写 wheelchair_ipc/browser_config.json
//  data: { bookmarks: [{name,url}], idleLock: bool }
// ============================================================
HostAPI.registerAction('ipcWriteBrowserConfig', async function(data, ctx) {
    try {
        var tempFolder = await fs.getTemporaryFolder();
        var ipcFolder;
        try { ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
        catch (e) { ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
        var file;
        try { file = await ipcFolder.getEntry('browser_config.json'); }
        catch (e) { file = await ipcFolder.createFile('browser_config.json'); }
        await file.write(JSON.stringify({
            ts: Date.now(),
            bookmarks: (data && data.bookmarks) || [],
            idleLock: !(data && data.idleLock === false)   // 默认 true, 显式 false 才关
        }));
        try { ctx.logToPanel('[浏览器] 配置已同步 (书签 ' + (((data && data.bookmarks) || []).length) + ' 条, 寸止 ' + (!(data && data.idleLock === false) ? '开' : '关') + ')', 'info'); } catch (_) {}
    } catch (e) {
        try { ctx.logToPanel('[浏览器] 配置同步失败: ' + e.message, 'warn'); } catch (_) {}
    }
}, { tileId: 'browser' });

module.exports = {};
