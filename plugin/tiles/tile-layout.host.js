// ============================================================
//  tile-layout.host.js
//  布局快照管理后端处理器
//  - 工厂布局: 插件目录/factory_layouts/*.json (只读)
//  - 用户布局: dataFolder/user_layouts/*.json (可读写)
// ============================================================

var HostAPI = require('../host/host-api.js');
var uxpModule = require('uxp');
var storage = uxpModule.storage;
var fs = storage.localFileSystem;

var FACTORY_LAYOUTS_FOLDER = 'factory_layouts';
var USER_LAYOUTS_SUBFOLDER = 'user_layouts';

// 文件名转 safe (中英文/下划线/中划线/数字),最长 64
function _sanitizeName(name) {
  if (!name) return 'layout';
  var s = String(name).replace(/[\\\/:*?"<>|\r\n\t]/g, '').slice(0, 64).trim();
  return s || 'layout';
}

// ============================================================
//  layoutScan — 扫描所有可用布局(工厂 + 用户)
//  返回 { factoryLayouts: [...], userLayouts: [...] }
// ============================================================
HostAPI.registerAction('layoutScan', async function(data, ctx) {
    var factoryLayouts = [];
    var userLayouts = [];

    // 工厂布局
    try {
        var pluginFolder = await fs.getPluginFolder();
        var factoryFolder = await pluginFolder.getEntry(FACTORY_LAYOUTS_FOLDER);
        var entries = await factoryFolder.getEntries();
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.isFolder || !e.name.toLowerCase().endsWith('.json')) continue;
            try {
                var content = await e.read();
                var parsed = JSON.parse(content);
                factoryLayouts.push({
                    fileName: e.name,
                    name: parsed.name || e.name.replace(/\.json$/i, ''),
                    desc: parsed.desc || '',
                    createdAt: parsed.createdAt || '',
                    isFactory: true
                });
            } catch (e1) {
                console.warn('[layout] factory parse fail:', e.name, e1.message);
            }
        }
    } catch (e) {
        console.warn('[layout] factory_layouts/ 不存在或读失败:', e.message);
    }

    // 用户布局
    try {
        var dataFolder = await fs.getDataFolder();
        var userFolder;
        try { userFolder = await dataFolder.getEntry(USER_LAYOUTS_SUBFOLDER); }
        catch (e2) { userFolder = await dataFolder.createFolder(USER_LAYOUTS_SUBFOLDER); }

        var userEntries = await userFolder.getEntries();
        for (var j = 0; j < userEntries.length; j++) {
            var ue = userEntries[j];
            if (ue.isFolder || !ue.name.toLowerCase().endsWith('.json')) continue;
            try {
                var ucontent = await ue.read();
                var uparsed = JSON.parse(ucontent);
                userLayouts.push({
                    fileName: ue.name,
                    name: uparsed.name || ue.name.replace(/\.json$/i, ''),
                    desc: uparsed.desc || '',
                    createdAt: uparsed.createdAt || '',
                    isFactory: false
                });
            } catch (e3) {
                console.warn('[layout] user parse fail:', ue.name, e3.message);
            }
        }
    } catch (e) {
        console.warn('[layout] user_layouts/ 创建失败:', e.message);
    }

    factoryLayouts.sort(function(a, b) { return a.fileName.localeCompare(b.fileName); });
    userLayouts.sort(function(a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });

    ctx.sendToPanel('layoutScanResult', {
        factoryLayouts: factoryLayouts,
        userLayouts: userLayouts
    });
    return true;
});

// ============================================================
//  layoutLoad — 读取单个布局文件的完整内容
//  data: { fileName, isFactory }
// ============================================================
HostAPI.registerAction('layoutLoad', async function(data, ctx) {
    if (!data || !data.fileName) {
        ctx.sendToPanel('layoutLoadResult', { success: false, error: '缺少 fileName' });
        return true;
    }
    try {
        var folder;
        if (data.isFactory) {
            var pluginFolder = await fs.getPluginFolder();
            folder = await pluginFolder.getEntry(FACTORY_LAYOUTS_FOLDER);
        } else {
            var dataFolder = await fs.getDataFolder();
            folder = await dataFolder.getEntry(USER_LAYOUTS_SUBFOLDER);
        }
        var entry = await folder.getEntry(data.fileName);
        var content = await entry.read();
        var parsed = JSON.parse(content);
        ctx.sendToPanel('layoutLoadResult', { success: true, layout: parsed, fileName: data.fileName });
    } catch (e) {
        ctx.sendToPanel('layoutLoadResult', { success: false, error: e.message });
    }
    return true;
});

// ============================================================
//  layoutSaveUser — 保存当前布局为用户布局
//  data: { name, desc, data }
// ============================================================
HostAPI.registerAction('layoutSaveUser', async function(data, ctx) {
    if (!data || !data.name || !data.data) {
        ctx.sendToPanel('layoutSaveResult', { success: false, error: '参数不完整' });
        return true;
    }
    try {
        var dataFolder = await fs.getDataFolder();
        var userFolder;
        try { userFolder = await dataFolder.getEntry(USER_LAYOUTS_SUBFOLDER); }
        catch (e) { userFolder = await dataFolder.createFolder(USER_LAYOUTS_SUBFOLDER); }

        var safeName = _sanitizeName(data.name);
        var fileName = safeName + '.json';
        var payload = {
            name: data.name,
            desc: data.desc || '',
            createdAt: new Date().toISOString(),
            data: data.data
        };
        var file = await userFolder.createFile(fileName, { overwrite: true });
        await file.write(JSON.stringify(payload, null, 2));
        ctx.logToPanel('[布局] 已保存: ' + data.name, 'success');
        ctx.sendToPanel('layoutSaveResult', { success: true, fileName: fileName });
    } catch (e) {
        ctx.logToPanel('[布局] 保存失败: ' + e.message, 'error');
        ctx.sendToPanel('layoutSaveResult', { success: false, error: e.message });
    }
    return true;
});

// ============================================================
//  layoutDeleteUser — 删除一个用户布局
// ============================================================
HostAPI.registerAction('layoutDeleteUser', async function(data, ctx) {
    if (!data || !data.fileName) {
        ctx.sendToPanel('layoutDeleteResult', { success: false, error: '缺少 fileName' });
        return true;
    }
    try {
        var dataFolder = await fs.getDataFolder();
        var userFolder = await dataFolder.getEntry(USER_LAYOUTS_SUBFOLDER);
        var entry = await userFolder.getEntry(data.fileName);
        await entry.delete();
        ctx.logToPanel('[布局] 已删除: ' + data.fileName, 'info');
        ctx.sendToPanel('layoutDeleteResult', { success: true, fileName: data.fileName });
    } catch (e) {
        ctx.sendToPanel('layoutDeleteResult', { success: false, error: e.message });
    }
    return true;
});

// ============================================================
//  layoutOpenUserFolder — 打开用户布局文件夹(用户手动管理 JSON)
// ============================================================
HostAPI.registerAction('layoutOpenUserFolder', async function(data, ctx) {
    try {
        var dataFolder = await fs.getDataFolder();
        var userFolder;
        var justCreated = false;
        try {
            userFolder = await dataFolder.getEntry(USER_LAYOUTS_SUBFOLDER);
        } catch (e) {
            userFolder = await dataFolder.createFolder(USER_LAYOUTS_SUBFOLDER);
            justCreated = true;
        }
        // 刚创建的文件夹要让 FS 元数据稳定后再调 shell,否则 Windows 上 ShellExecute 偶尔会让 PS 崩溃
        if (justCreated) {
            await new Promise(function(r) { setTimeout(r, 200); });
        }
        var folderPath = userFolder.nativePath;
        // 用通用三段降级 helper(shell.openPath / openExternal file:/// / openExternal raw)
        // 比直接 shell.openPath 稳定;某些 PS 版本/路径下 openPath 会触发 UXP 崩溃
        if (ctx.openFolderWithMultipleMethods) {
            await ctx.openFolderWithMultipleMethods(folderPath, '[布局]');
        } else {
            // 兜底:旧路径
            var shell = uxpModule.shell;
            if (shell && shell.openExternal) {
                var fileUrl = 'file:///' + folderPath.replace(/\\/g, '/').replace(/^\/+/, '');
                await shell.openExternal(fileUrl, 'Open layout folder');
            }
        }
    } catch (e) {
        ctx.logToPanel('[布局] 打开文件夹失败: ' + e.message, 'error');
    }
    return true;
});
