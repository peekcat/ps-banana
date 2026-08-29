const hostApi = require('./host-api.js');
const bootstrapHandlers = require('./bootstrap-handlers.js');
const tileScannerHandlers = require('./tile-scanner-handlers.js');
const lowRiskHandlers = require('./low-risk-handlers.js');
const selectionFlowHandlers = require('./selection-flow-handlers.js');
const highRiskTaskHandlers = require('./high-risk-task-handlers.js');
const stopControlHandlers = require('./stop-control-handlers.js');
const miscHandlers = require('./misc-handlers.js');

async function routeHostMessage(action, data, ctx) {
    // 0. 先查磁贴插件注册的 action（HostAPI.registerAction）
    if (hostApi.hasAction(action)) {
        return await hostApi.dispatchAction(action, data || {}, ctx);
    }

    var handled = await tileScannerHandlers.handleTileScannerAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await bootstrapHandlers.handleBootstrapAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await lowRiskHandlers.handleLowRiskAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await selectionFlowHandlers.handleSelectionFlowAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await highRiskTaskHandlers.handleHighRiskTaskAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await stopControlHandlers.handleStopControlAction(action, data || {}, ctx);
    if (handled) return true;

    handled = await miscHandlers.handleMiscAction(action, data || {}, ctx);
    if (handled) return true;

    return false;
}

module.exports = {
    routeHostMessage: routeHostMessage
};
