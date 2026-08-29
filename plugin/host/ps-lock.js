// ============================================================
//  ps-lock.js
//  PS操作串行锁：防止多个组同时操作PS导致冲突
//
//  从 index.js 抽出，行为完全一致。
//  使用工厂函数 createPSLock，队列状态封装在闭包中。
//
//  60 分钟超时兜底:
//    PS 处于无法响应模态调用的状态(比如用户在裁切/液化中)时,
//    executeAsModal 可能永远不返回也不抛错 → 锁卡死 → 后续任务全堵
//    加 3600s race,超时强制 reject,让外层 catch 走 cache + pending 路径
//    3600s 选值依据:与生成主链路超时统一拉满
// ============================================================

var PS_LOCK_TIMEOUT_MS = 3600 * 1000;

function createPSLock(deps) {
    var sleep = deps.sleep;

    var _psLockQueue = [];
    var _psLockRunning = false;

function acquirePSLock(fn, taskId) {
    return new Promise(function(resolve, reject) {
        _psLockQueue.push({ fn: fn, resolve: resolve, reject: reject, taskId: taskId || null });
        _processPSLock();
    });
}

async function _processPSLock() {
    if (_psLockRunning) return;
    if (_psLockQueue.length === 0) return;
    _psLockRunning = true;
    var item = _psLockQueue.shift();
    var operation = Promise.resolve().then(function() { return item.fn(); });
    var timeoutId = null;
    var timedOut = false;
    try {
        // 超时只通知调用者，不能释放锁。UXP 无法强制取消已经进入
        // executeAsModal 的操作；若此时放行下一项，新旧 PS 操作会重叠。
        var result = await Promise.race([
            operation,
            new Promise(function(_, reject) {
                timeoutId = setTimeout(function() {
                    timedOut = true;
                    reject(new Error('PS 锁超时(3600s):PS 当前可能处于无法响应的状态，请结束当前 Photoshop 操作后重试'));
                }, PS_LOCK_TIMEOUT_MS);
            })
        ]);
        item.resolve(result);
    } catch(e) {
        item.reject(e);
        // 调用者已经收到超时，但锁继续占用到旧操作真实结束。
        if (timedOut) {
            try { await operation; } catch (_) {}
        }
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        _psLockRunning = false;
        // 加入微小延迟防止PS操作冲突
        await sleep(200);
        _processPSLock();
    }
}

// === 清空PS串行锁队列（可按taskId定向清空） ===
function clearPSLockQueue(taskId) {
    var dropped = 0;
    if (!taskId) {
        while (_psLockQueue.length > 0) {
            var item = _psLockQueue.shift();
            dropped++;
            try { item.reject(new Error("已被提前结束")); } catch(e) {}
        }
        return dropped;
    }

    var remaining = [];
    for (var i = 0; i < _psLockQueue.length; i++) {
        var qItem = _psLockQueue[i];
        if (qItem.taskId === taskId) {
            dropped++;
            try { qItem.reject(new Error("已被提前结束")); } catch(e) {}
        } else {
            remaining.push(qItem);
        }
    }
    _psLockQueue = remaining;
    return dropped;
}

    return {
        acquirePSLock: acquirePSLock,
        _processPSLock: _processPSLock,
        clearPSLockQueue: clearPSLockQueue
    };
}

module.exports = { createPSLock: createPSLock };
