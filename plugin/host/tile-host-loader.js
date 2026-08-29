// ============================================================
//  tile-host-loader.js
//  启动时扫描 tiles/ 目录，把所有 *.host.js 文件 require 进来。
//  这些文件会在被 require 时自己调用 HostAPI.registerAction 注册处理器。
// ============================================================

async function loadTileHosts(uxpModule) {
    const fs = uxpModule.storage.localFileSystem;
    const pluginFolder = await fs.getPluginFolder();
    const tilesFolder = await pluginFolder.getEntry('tiles');
    const entries = await tilesFolder.getEntries();

    const hostFiles = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.isFile && /^tile-.+\.host\.js$/i.test(entry.name)) {
            hostFiles.push(entry.name);
        }
    }
    hostFiles.sort();

    const loaded = [];
    const failed = [];
    for (let i = 0; i < hostFiles.length; i++) {
        const name = hostFiles[i];
        try {
            require('../tiles/' + name);
            loaded.push(name);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            console.error('[tile-host-loader] 加载失败 ' + name + ': ' + msg);
            failed.push({ name: name, error: msg });
        }
    }

    console.log('[tile-host-loader] 发现 ' + hostFiles.length + ' 个 .host.js 文件，成功加载 ' + loaded.length + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个' : ''));

    return { discovered: hostFiles.length, loaded: loaded, failed: failed };
}

module.exports = { loadTileHosts: loadTileHosts };
