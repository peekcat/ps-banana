// ============================================================
//  tile-chat.host.js
//  AI 助手聊天数据持久化后端处理器
//  原代码从 index.js handleSaveChatData / handleLoadChatData 迁移
// ============================================================

var HostAPI = require('../host/host-api.js');

// ── saveChatData ──
HostAPI.registerAction('saveChatData', async function(data, ctx) {
    var type = data.type; // 'sessions' | 'roles' | 'settings'
    var content = data.data;
    if (!type || content === undefined) return;
    try {
        var chatFolder = await ctx.getOrCreateChatDataFolder();
        var fileName = type + '.json';
        var file = await chatFolder.createFile(fileName, { overwrite: true });
        // 紧凑格式写盘(2026-07-04 性能优化): 聊天记录没人手动看, 美化缩进白白让体积和序列化耗时翻倍
        var jsonStr = (typeof content === 'string') ? content : JSON.stringify(content);
        await file.write(jsonStr);
        console.log("[聊天数据] 已保存: " + fileName + " (" + jsonStr.length + " bytes)");
    } catch(e) {
        console.warn("[聊天数据] 保存失败 (" + type + "): " + e.message);
    }
}, { tileId: 'chat' });

// ── loadChatData ──
HostAPI.registerAction('loadChatData', async function(data, ctx) {
    var type = data.type; // 'sessions' | 'roles' | 'settings'
    if (!type) return;
    try {
        var chatFolder = await ctx.getOrCreateChatDataFolder();
        var fileName = type + '.json';
        var file = await chatFolder.getEntry(fileName);
        var text = await file.read();
        var parsed = JSON.parse(text);
        console.log("[聊天数据] 已加载: " + fileName);
        ctx.sendToPanel('chatDataLoaded', { type: type, data: parsed });
    } catch(e) {
        // 文件不存在 → 尝试从旧 webview_storage 迁移
        console.log("[聊天数据] " + type + ".json 不存在，尝试从旧存储迁移...");
        var migrated = null;
        var keyMap = { sessions: 'chat_sessions', roles: 'chat_roles_custom', settings: null };
        if (type === 'settings') {
            // settings 包含多个key，合并为一个对象
            var hostStorage = ctx.hostStorageRef && ctx.hostStorageRef.value ? ctx.hostStorageRef.value : {};
            migrated = {
                activeRole: hostStorage['chat_active_role'] || 'builtin_0',
                builtinOverrides: null,
                hiddenBuiltin: null
            };
            try { migrated.builtinOverrides = JSON.parse(hostStorage['chat_builtin_overrides'] || 'null'); } catch(x) {}
            try { migrated.hiddenBuiltin = JSON.parse(hostStorage['chat_hidden_builtin'] || 'null'); } catch(x) {}
            if (migrated.activeRole || migrated.builtinOverrides || migrated.hiddenBuiltin) {
                // 保存迁移数据到文件
                try {
                    var chatFolder2 = await ctx.getOrCreateChatDataFolder();
                    var mFile = await chatFolder2.createFile(type + '.json', { overwrite: true });
                    await mFile.write(JSON.stringify(migrated, null, 2));
                    ctx.logToPanel("[聊天数据] 已从旧存储迁移 settings", "info");
                } catch(me) {}
            }
        } else {
            var storageKey = keyMap[type];
            var hostStorage2 = ctx.hostStorageRef && ctx.hostStorageRef.value ? ctx.hostStorageRef.value : {};
            if (storageKey && hostStorage2[storageKey]) {
                try {
                    migrated = JSON.parse(hostStorage2[storageKey]);
                    // 保存迁移数据到文件
                    var chatFolder3 = await ctx.getOrCreateChatDataFolder();
                    var mFile2 = await chatFolder3.createFile(type + '.json', { overwrite: true });
                    await mFile2.write(JSON.stringify(migrated, null, 2));
                    ctx.logToPanel("[聊天数据] 已从旧存储迁移 " + type, "info");
                } catch(me2) {}
            }
        }
        ctx.sendToPanel('chatDataLoaded', { type: type, data: migrated });
    }
}, { tileId: 'chat' });
