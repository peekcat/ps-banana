var HostAPI = require('./host-api.js');

async function markRecordableStart(ctx) {
    try {
        var _psAction = require('photoshop').action;
        await _psAction.recordAction(
            {
                name: '轮椅开始生成',
                methodName: 'wheelchairRunSingleActionStep'
            },
            { 'com.xiasanqi.ps.wheelchair.v4.action': 'runSingle' }
        );
    } catch (e) {
        var _msg = '';
        try { _msg = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); }
        catch (_je) { _msg = String(e && e.message ? e.message : e); }
        console.warn('[录制标记] recordAction 失败（不影响生成）:', _msg);
        ctx.logToPanel('[录制标记] recordAction 失败: ' + _msg, 'warn');
    }
}

async function markRecordableAddToBatch(info, ctx) {
    try {
        var _psAction = require('photoshop').action;
        await _psAction.recordAction(
            {
                name: '轮椅添加到批处理',
                methodName: 'wheelchairAddToBatchActionStep'
            },
            info || {}
        );
    } catch (e) {
        var _msg = '';
        try { _msg = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); }
        catch (_je) { _msg = String(e && e.message ? e.message : e); }
        console.warn('[录制标记] addToBatch recordAction 失败（不影响功能）:', _msg);
        ctx.logToPanel('[录制标记] addToBatch recordAction 失败: ' + _msg, 'warn');
    }
}

async function markRecordableCaptureRefImage(ctx) {
    try {
        var _psAction = require('photoshop').action;
        await _psAction.recordAction(
            {
                name: '轮椅添加参考图',
                methodName: 'wheelchairCaptureRefImageActionStep'
            },
            {}
        );
    } catch (e) {
        var _msg = '';
        try { _msg = JSON.stringify(e, Object.getOwnPropertyNames(e || {})); }
        catch (_je) { _msg = String(e && e.message ? e.message : e); }
        console.warn('[录制标记] captureRef recordAction 失败（不影响功能）:', _msg);
        ctx.logToPanel('[录制标记] captureRef recordAction 失败: ' + _msg, 'warn');
    }
}

function bindRecordableActionSteps(ctx) {
    async function wheelchairRunSingleActionStep(executionContext, info) {
        try {
            ctx.sendToPanel('psRunSingleCommand', {});
            ctx.logToPanel('[动作回放] 已触发开始生成', 'info');
        } catch (e) {
            console.warn('[动作回放] 触发失败:', e && e.message ? e.message : e);
        }
        return info || {};
    }

    async function wheelchairAddToBatchActionStep(executionContext, info) {
        try {
            var handled = await HostAPI.dispatchAction('addToBatch', info || {}, ctx);
            if (!handled) throw new Error('addToBatch 后端动作未注册');
            ctx.logToPanel('[动作回放] 已触发添加到批处理', 'info');
        } catch (e) {
            console.warn('[动作回放] 添加到批处理失败:', e && e.message ? e.message : e);
        }
        return info || {};
    }

    async function wheelchairCaptureRefImageActionStep(executionContext, info) {
        try {
            if (!ctx || typeof ctx.acquirePSLock !== 'function') throw new Error('Photoshop global lock unavailable');
            await ctx.acquirePSLock(function() { return ctx.handleCaptureRefImage(); }, 'action-capture-ref-image');
            ctx.logToPanel('[动作回放] 已触发添加参考图', 'info');
        } catch (e) {
            console.warn('[动作回放] 添加参考图失败:', e && e.message ? e.message : e);
        }
        return info || {};
    }

    try {
        globalThis.wheelchairRunSingleActionStep = wheelchairRunSingleActionStep;
        globalThis.wheelchairAddToBatchActionStep = wheelchairAddToBatchActionStep;
        globalThis.wheelchairCaptureRefImageActionStep = wheelchairCaptureRefImageActionStep;
    } catch (_bindErr) {
        console.warn('[动作回放] 绑定全局函数失败:', _bindErr && _bindErr.message ? _bindErr.message : _bindErr);
    }
}

module.exports = {
    bindRecordableActionSteps: bindRecordableActionSteps,
    markRecordableStart: markRecordableStart,
    markRecordableAddToBatch: markRecordableAddToBatch,
    markRecordableCaptureRefImage: markRecordableCaptureRefImage
};
