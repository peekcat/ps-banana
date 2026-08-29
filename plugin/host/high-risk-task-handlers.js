async function handleHighRiskTaskAction(action, data, ctx) {
    switch (action) {
        // recordableRunSingle / runSingle 已迁移到 tiles/tile-run.host.js
        // setTaskAutoReturn / returnTaskResult / clearTaskCache / grsCheckCredits / checkQuota 已迁移到 tiles/tile-tasks.host.js
        // addToBatch / recordableAddToBatch / runBatch 已迁移到 tiles/tile-batch.host.js
        // recordableCaptureRefImage 已删 (PS 动作回放走 recordable-actions.js 全局函数, 不走此路由)

        // colorGradeTask 已迁移到 tiles/tile-colorgrade.host.js
        // startTiledUpscale / confirmTiledUpscaleYes / tiledFillTest 已迁移到 tiles/tile-tiled.host.js
        // startGlobalPartition / confirmGlobalPartitionYes 已迁移到 tiles/tile-partition.host.js
        // forge* cases migrated to tiles/tile-forge.host.js
        // comfy* cases migrated to tiles/tile-comfyui.host.js
    }

    return false;
}

module.exports = {
    handleHighRiskTaskAction: handleHighRiskTaskAction
};
