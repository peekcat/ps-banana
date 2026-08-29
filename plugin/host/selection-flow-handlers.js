// 本次会话是否已自动导入过选框工具预设。
// 防止"命令'选择'当前不可用"(用户当前不是选框工具时 select toolPreset 会报这个,
// 但预设其实在)被误判成预设缺失而反复 append 导入, 把工具预设堆出几十份重复。
var _autoImportedThisSession = false;

function _withPSLock(ctx, taskId, fn) {
    if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
    return ctx.acquirePSLock(fn, taskId);
}

async function handleSelectionFlowAction(action, data, ctx) {
    switch (action) {
        case 'captureRefImage':
            await _withPSLock(ctx, 'capture-ref-image', function() { return ctx.handleCaptureRefImage(); });
            return true;

        case 'restoreSelectionFromHistory':
            await _withPSLock(ctx, 'restore-selection-history', function() { return ctx.handleRestoreSelectionFromHistory(data); });
            return true;

        case 'recaptureRefImage':
            await _withPSLock(ctx, 'recapture-ref-image', function() { return ctx.handleRecaptureRefImage(data); });
            return true;

        case 'probeSelectionRect':
            // 比例预警用 — 不抓像素, 只回选区矩形和文档尺寸
            var probeRes = await _withPSLock(ctx, 'probe-selection-rect', function() { return ctx.probeSelectionRect(); });
            ctx.sendToPanel('probeSelectionRectResult', probeRes);
            return true;

        case 'syncMarqueeAspect':
            // 切换 PS 矩形选框工具到对应比例的工具预设
            //   data.aspect: '1:1' | '16:9' | ... | 'Auto'
            //   预设名: '修图轮椅_<aspect>'
            //
            //   静默导入逻辑:
            //   1. 先尝试 select 预设
            //   2. 失败 (预设不存在) → 调 importMarqueePresets() 从插件目录导入 .tpl
            //   3. 导入成功 → 再 select 一次
            //   4. 还失败 → 真返回错误给 panel toast
            var syncRes = await _withPSLock(ctx, 'sync-marquee-aspect', function() {
                return ctx.setMarqueeAspectPreset(data && data.aspect);
            });
            // 方案1: "命令'选择'当前不可用" 是"当前激活的不是矩形选框工具"等上下文问题,
            //        预设其实好好装着 —— 绝不能当成缺失去 append 导入, 否则工具预设会堆出一堆重复。
            var _syncErr = syncRes.error || '';
            var _cmdUnavailable = /当前不可用|not currently available|currently not available/i.test(_syncErr);
            if (!syncRes.success && !_cmdUnavailable && !_autoImportedThisSession && /不可用|不存在|not available/.test(_syncErr)) {
                // 排除上下文错误后, 才把 "不存在/不可用" 视作可能缺失 → 本会话只自动导入这一次 (见上方 flag 说明)
                var importRes = await _withPSLock(ctx, 'import-marquee-presets:auto', function() {
                    return ctx.importMarqueePresets();
                });
                if (importRes.success) {
                    _autoImportedThisSession = true;   // 已导过一次, 本会话不再自动导入 (防重复堆叠)
                    syncRes = await _withPSLock(ctx, 'sync-marquee-aspect:retry', function() {
                        return ctx.setMarqueeAspectPreset(data && data.aspect);
                    });
                    if (syncRes.success) {
                        syncRes.autoImported = true;
                        ctx.logToPanel('[选框比例] 已自动导入工具预设', 'info');
                    }
                } else {
                    syncRes.importError = importRes.error;
                }
            }
            ctx.sendToPanel('syncMarqueeAspectResult', syncRes);
            return true;

        case 'importMarqueePresets':
            // 手动触发预设导入 (设置磁贴的"导入预设"按钮用)
            var impRes = await _withPSLock(ctx, 'import-marquee-presets', function() {
                return ctx.importMarqueePresets();
            });
            ctx.sendToPanel('importMarqueePresetsResult', impRes);
            return true;
    }

    return false;
}

module.exports = {
    handleSelectionFlowAction: handleSelectionFlowAction
};
