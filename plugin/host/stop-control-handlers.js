async function handleStopControlAction(action, data, ctx) {
    switch (action) {
        case 'earlyStop':
            // 回收站改造后, earlyStop 语义软化:
            //   - g_earlyStop 仅表示"UI 已退出", callAiApi 的 softMode 任务后台继续跑
            //   - abortAllActiveRequests() 默认跳过 softMode controller (Forge/Comfy/旧调用照常 abort)
            //   - PS 锁队列照常清空 (已生成的图本来就走归档, 不再走自动贴回)
            ctx.g_earlyStopRef.value = true;
            var abortedCount = ctx.abortAllActiveRequests();   // 默认 force=false, 跳过 softMode
            var droppedPsJobs = ctx.clearPSLockQueue();
            try {
                // 清空 task controller 列表里的硬中断项, softMode 项保留在 g_activeControllers (上面 splice 过了)
                Object.keys(ctx.g_taskControllers).forEach(function (_tid) {
                    var arr = ctx.g_taskControllers[_tid] || [];
                    ctx.g_taskControllers[_tid] = arr.filter(function(e) { return e && e.softMode; });
                });
                Object.keys(ctx.g_taskEarlyStop).forEach(function (_tid) { ctx.g_taskEarlyStop[_tid] = true; });
            } catch (_es) {}
            // 全局标志只用于把这一次“停止全部”传播给当前任务。后续任务使用
            // 各自的 g_taskEarlyStop，不能继承一次永久为 true 的全局状态。
            ctx.g_earlyStopRef.value = false;
            ctx.logToPanel('[提前结束] 已中断 ' + abortedCount + ' 个硬中断请求 (软中断任务后台继续), 清空 ' + droppedPsJobs + ' 个 PS 任务', 'warn');
            return true;

        case 'earlyStopTask':
            var stopTaskId = data.taskId;
            ctx.g_taskEarlyStop[stopTaskId] = true;
            var taskCtrlCount = 0;
            if (ctx.g_taskControllers[stopTaskId]) {
                var arr2 = ctx.g_taskControllers[stopTaskId];
                var kept2 = [];
                for (var tci = 0; tci < arr2.length; tci++) {
                    var entry = arr2[tci];
                    if (entry && entry.softMode) {
                        // 软中断: UI 已释放, 后台继续到结果归档
                        kept2.push(entry);
                        continue;
                    }
                    taskCtrlCount++;
                    clearTimeout(entry.timeoutId);
                    try { entry.controller.abort(); } catch (tce) {}
                }
                ctx.g_taskControllers[stopTaskId] = kept2;
            }
            var droppedTaskPsJobs = ctx.clearPSLockQueue(stopTaskId);
            ctx.logToPanel('[提前结束] 任务 ' + stopTaskId + ': 中断 ' + taskCtrlCount + ' 个硬中断请求 (软中断后台继续), 清空 ' + droppedTaskPsJobs + ' 个 PS 任务', 'warn');
            return true;

        case 'extendTimeout':
            var extraSec = (data && data.seconds) || 10;
            var extendedCount = ctx.extendAllTimeouts(extraSec);
            ctx.logToPanel('[超时] 已为 ' + extendedCount + ' 个活跃请求延长 ' + extraSec + ' 秒', 'info');
            return true;
    }

    return false;
}

module.exports = {
    handleStopControlAction: handleStopControlAction
};
