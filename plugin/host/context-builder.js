function createHostContext(deps) {
    return {
        storage: deps.storage,
        uxpModule: deps.uxpModule,
        psAppVersion: deps.psAppVersion || '',
        sendToPanel: deps.sendToPanel,
        logToPanel: deps.logToPanel,
        arrayBufferToBase64: deps.arrayBufferToBase64,
        findSoundFileEntry: deps.findSoundFileEntry,
        scanSoundFiles: deps.scanSoundFiles,
        getOrCreateChatDataFolder: deps.getOrCreateChatDataFolder,
        getOrCreateImageCacheFolder: deps.getOrCreateImageCacheFolder,
        beginImageCacheClear: deps.beginImageCacheClear,
        endImageCacheClear: deps.endImageCacheClear,
        deleteFolderContents: deps.deleteFolderContents,

        loadHostStorage: deps.loadHostStorage,
        storageReady: deps.storageReady,
        debounceSave: deps.debounceSave,
        cancelDebounce: deps.cancelDebounce,
        saveHostStorage: deps.saveHostStorage,
        hostStorageRef: deps.hostStorageRef,
        g_antiTruncationModeRef: deps.g_antiTruncationModeRef,
        g_autoPadCropRef: deps.g_autoPadCropRef,
        g_fix4kMagentaRef: deps.g_fix4kMagentaRef,
        g_colorStableRef: deps.g_colorStableRef,
        g_layerTypeRef: deps.g_layerTypeRef,
        g_maxResolutionRef: deps.g_maxResolutionRef,
        g_autoGroupRef: deps.g_autoGroupRef,
        g_autoSelectFullCanvasNoSelectionRef: deps.g_autoSelectFullCanvasNoSelectionRef,
        g_teachModeRef: deps.g_teachModeRef,
        g_returnFeatherEnabledRef: deps.g_returnFeatherEnabledRef,
        g_returnFeatherWorkflowsRef: deps.g_returnFeatherWorkflowsRef,
        g_returnFeatherShrinkPercentRef: deps.g_returnFeatherShrinkPercentRef,
        g_returnFeatherBlurPercentRef: deps.g_returnFeatherBlurPercentRef,

        handleCaptureRefImage: deps.handleCaptureRefImage,
        handleRecaptureMainImage: deps.handleRecaptureMainImage,
        handleRestoreSelection: deps.handleRestoreSelection,
        handleRestoreSelectionFromHistory: deps.handleRestoreSelectionFromHistory,
        handleRecaptureRefImage: deps.handleRecaptureRefImage,
        probeSelectionRect: deps.probeSelectionRect,
        setMarqueeAspectPreset: deps.setMarqueeAspectPreset,
        importMarqueePresets: deps.importMarqueePresets,

        markRecordableStart: deps.markRecordableStart,
        markRecordableAddToBatch: deps.markRecordableAddToBatch,
        markRecordableCaptureRefImage: deps.markRecordableCaptureRefImage,
        // handleRunSingle / handleReturnTaskResult / handleAddToBatch / handleRunBatch 已迁移到 tile host
        // handleColorGradeTask 已迁移到 tiles/tile-colorgrade.host.js
        g_taskAutoReturn: deps.g_taskAutoReturn,
        g_taskResultCache: deps.g_taskResultCache,
        // handleStartTiledUpscale / executeTiledUpscale / handleTiledFillTest 已迁移到 tiles/tile-tiled.host.js
        callAiApi: deps.callAiApi,
        sanitizePrompt: deps.sanitizePrompt,
        createConcurrencyPool: deps.createConcurrencyPool,
        handleFetchOpenDocs: deps.handleFetchOpenDocs,
        // handleStartGlobalPartition / executeGlobalPartition 已迁移到 tiles/tile-partition.host.js
        // handleGrsCheckCredits / handleCheckQuota 已迁移到 tiles/tile-tasks.host.js
        // --- 全局分区所需（供 tile-partition.host.js 使用） ---
        acquirePSLock: deps.acquirePSLock,
        playSingleFailSound: deps.playSingleFailSound,
        playAllFailSound: deps.playAllFailSound,
        savePromptTxtToRunFolder: deps.savePromptTxtToRunFolder,
        calculatePartitionSelections: deps.calculatePartitionSelections,
        getErrorMessage: deps.getErrorMessage,
        getErrorSolution: deps.getErrorSolution,

        // --- Forge / Run / Batch 所需的 PS 辅助函数 ---
        getSelectionAndImage: deps.getSelectionAndImage,
        createImageCacheRunFolder: deps.createImageCacheRunFolder,
        saveImageToRunFolder: deps.saveImageToRunFolder,
        deselectAll: deps.deselectAll,
        placeImageToSpecificDoc: deps.placeImageToSpecificDoc,
        placeImagesBatch: deps.placeImagesBatch,
        placeImagesAuto: deps.placeImagesAuto,
        applyReturnFeatherMaskToLayer: deps.applyReturnFeatherMaskToLayer,
        shouldApplyReturnFeather: deps.shouldApplyReturnFeather,
        createGroupAndMask: deps.createGroupAndMask,
        applyMagentaFixCurveToGroup: deps.applyMagentaFixCurveToGroup,
        createTeachingMaterials: deps.createTeachingMaterials,
        playSuccessSound: deps.playSuccessSound,
        sanitizeFileName: deps.sanitizeFileName,
        getUniqueFileName: deps.getUniqueFileName,
        getOrCreateForgePresetsFolder: deps.getOrCreateForgePresetsFolder,
        getOrCreatePresetsFolder: deps.getOrCreatePresetsFolder,

        // handleComfy* 已迁移到 tiles/tile-comfyui.host.js

        g_taskCompleteSentRef: deps.g_taskCompleteSentRef,
        g_lastSelectionRef: deps.g_lastSelectionRef,
        g_lastSelectionDocIdRef: deps.g_lastSelectionDocIdRef,
        g_lastCaptureBase64Ref: deps.g_lastCaptureBase64Ref,
        g_activeControllersRef: deps.g_activeControllersRef,
        g_earlyStopRef: deps.g_earlyStopRef,
        abortAllActiveRequests: deps.abortAllActiveRequests,
        clearPSLockQueue: deps.clearPSLockQueue,
        g_taskControllers: deps.g_taskControllers,
        g_taskEarlyStop: deps.g_taskEarlyStop,
        sendTaskCompleteOnce: deps.sendTaskCompleteOnce,
        extendAllTimeouts: deps.extendAllTimeouts,

        // handleOpenPresetFolder / handleRefreshPresets / exportPreset / importPreset / handleLoadPresetsFile / handleSavePresetsFile 已迁移到 tiles/tile-presets.host.js
        // handleSaveChatData / handleLoadChatData 已迁移到 tiles/tile-chat.host.js

        // handleCalibrateBalance 已迁移到 tiles/tile-tasks.host.js
        handleCaptureForChat: deps.handleCaptureForChat,
        // handleYoudaoTranslate 已迁移到 tiles/tile-translate.host.js
        // handleCloud* 已迁移到 tiles/tile-cloud.host.js
        ipcWriteState: deps.ipcWriteState,
        ipcReadCommand: deps.ipcReadCommand,
        openFolderWithMultipleMethods: deps.openFolderWithMultipleMethods,

        // === 回收站持久层 ===
        // archiveToRecycleBin(meta, base64, status, errMsg)
        //   meta: { id, workflow, prompt, model, provider, size, aspectRatio, context: {docId, docName, selection, antiMode, layerType, groupName}, extras }
        //   base64: 成功的图 (失败/aborted 传 null)
        //   status: 'success' | 'late' | 'failed' | 'aborted'
        //   errMsg: 可选, 失败/aborted 时附说明
        archiveToRecycleBin: deps.archiveToRecycleBin,
        // 任务启动时调一次, 一次性插 N 条 status='pending' 占位 (回收站会立刻显示 N 个灰色槽位)
        //   metas: 已构造好的 meta 数组. 每个 meta 的 id 必须和后续 archiveToRecycleBin 的 meta.id 一致, 才能对上更新
        beginBatchPendingArchive: deps.beginBatchPendingArchive,
        // 回收站读取 API (供 tile-recyclebin.host.js 用)
        recycleBin: deps.recycleBin
    };
}

module.exports = {
    createHostContext: createHostContext
};
