// ============================================================
//  ipc.js
//  IPC 卫星插件通信（文件系统）
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createIPCModule 注入外部依赖。
// ============================================================

function createIPCModule(deps) {
    var fs = deps.fs;
    var sendToPanel = deps.sendToPanel;

    var _ipcFolder = null;
    var _ipcLastCmdTs = 0;

    // 自适应轮询 (2026-07-04 性能优化):
    //   高速档 30ms — 最近 2 分钟内收到过卫星命令(卫星正在被用)
    //   省电档 500ms — 其余时间(绝大多数用户从不用卫星, 30ms 空转=每秒 33 次白读磁盘)
    //   收到命令瞬间切回高速档; 闲置后按的第一下最多慢半秒(面板有乐观更新, 体感无差)
    var IPC_POLL_FAST_MS = 30;
    var IPC_POLL_IDLE_MS = 500;
    var IPC_FAST_WINDOW_MS = 2 * 60 * 1000;   // 收到命令后保持高速档的时长
    var _ipcLastActiveAt = 0;                 // 最后一次收到命令的时刻
    var _ipcPollTimer = null;

    function _ipcCurrentDelay() {
        return (Date.now() - _ipcLastActiveAt < IPC_FAST_WINDOW_MS) ? IPC_POLL_FAST_MS : IPC_POLL_IDLE_MS;
    }

    function _ipcScheduleNext() {
        _ipcPollTimer = setTimeout(async function() {
            try { await ipcPollCommand(); } catch(e) {}
            _ipcScheduleNext();
        }, _ipcCurrentDelay());
    }

async function initIPC() {
    try {
        var tempFolder = await fs.getTemporaryFolder();
        try { _ipcFolder = await tempFolder.getEntry('wheelchair_ipc'); }
        catch(e) { _ipcFolder = await tempFolder.createFolder('wheelchair_ipc'); }
        // 自适应轮询: 活跃 30ms / 闲置 500ms (见顶部说明)
        _ipcScheduleNext();
        var ipcPath = _ipcFolder.nativePath || 'unknown';
        sendToPanel('ipcReady', { dir: ipcPath });
        console.log("[IPC] 初始化完成: " + ipcPath);
        // 写一个标记文件让卫星插件能通过搜索找到这个路径
        try {
            var markerFile;
            try { markerFile = await _ipcFolder.getEntry('_path.txt'); } catch(e2) { markerFile = await _ipcFolder.createFile('_path.txt'); }
            await markerFile.write(ipcPath);
        } catch(e3) {}
    } catch(e) {
        console.warn("[IPC] 初始化失败:", e);
    }
}

async function ipcWriteState(stateObj) {
    if (!_ipcFolder) return;
    try {
        var file;
        try { file = await _ipcFolder.getEntry('state.json'); } catch(e) { file = await _ipcFolder.createFile('state.json'); }
        await file.write(JSON.stringify(stateObj));
    } catch(e) {}
}

async function ipcPollCommand() {
    if (!_ipcFolder) return;
    try {
        var file = await _ipcFolder.getEntry('command.json');
        var text = await file.read();
        if (!text || text === '{}') return;
        var cmd = JSON.parse(text);
        if (!cmd || !cmd.ts || cmd.ts <= _ipcLastCmdTs) return;
        _ipcLastCmdTs = cmd.ts;
        _ipcLastActiveAt = Date.now();   // 有命令进来 → 切回/保持 30ms 高速档
        // 清空命令文件
        await file.write('{}');
        // 转发给面板执行
        if (cmd.action) {
            sendToPanel('ipcCommand', { action: cmd.action, data: cmd.data || {} });
        }
    } catch(e) {} // command.json 不存在时静默忽略
}

async function ipcReadCommand() {
    // 由面板主动触发的轮询（备用方式，现在用 setInterval 替代）
    await ipcPollCommand();
}

    return {
        initIPC: initIPC,
        ipcWriteState: ipcWriteState,
        ipcPollCommand: ipcPollCommand,
        ipcReadCommand: ipcReadCommand
    };
}

module.exports = { createIPCModule: createIPCModule };
