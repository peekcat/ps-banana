# GPTdev Code Map

> Generated for the current UXP plugin workspace on 2026-06-10.
> This file is a source-oriented map for future GPT/Codex development work.
> It summarizes the live codebase, with `_dev/` notes cross-checked against current source where possible.

## 0A. Coverage Scope and Verification

This code map is now tied to an explicit full-file inventory, not only to the major boot paths.

Scan date: 2026-06-10

Runtime/code-file scope:

- Included extensions: `.js`, `.css`, `.html`, `.json`, `.bat`.
- Excluded asset/preset roots: `icons/**`, `audios/**`, `factory_presets/**`, `factory_forge_presets/**`, `factory_presets_tpl/**`.
- Excluded from the code-file count: zip payloads (`browser-pkg.zip`, `satellite-pkg.zip`), Markdown docs, knowledge-base docs, skill docs, and this `GPTdev.md` file.
- Result: 181 scoped code/config/script files.

Extension count:

- `.js`: 121
- `.css`: 46
- `.html`: 3
- `.json`: 8
- `.bat`: 3

Directory count:

- root: 11
- `_dev`: 3 runtime templates
- `core`: 13
- `defaults`: 6
- `factory_layouts`: 3
- `factory_scenes`: 1
- `host`: 22
- `styles`: 8
- `tiles`: 114

Verification passes used for this map:

- full scoped file inventory by extension and excluded roots;
- `TileAPI.registerTile(...)` scan for panel tile registration;
- `HostAPI.registerAction(...)` scan for host action registration;
- message boundary scan for `TileAPI.sendToHost`, `TileAPI.onHostMessage`, `sendToPanel`, `window._*`;
- storage/state scan for `TileAPI.storage.*`, `TileAPI.state.*`, and `localStorage`;
- `_dev/*.md` heading scan to align architecture, release, migration, UI, audit, and known-risk notes with source.

Full scoped inventory:

- root (11): `builtin_roles.json`, `index.html`, `index.js`, `install_browser.bat`, `install_satellite.bat`, `login-service.js`, `manifest.json`, `panel.html`, `update_plugin.bat`, `wheelchair-tutorial.html`, `workflow-engine.js`.
- `_dev` templates (3): `_TEMPLATE.css`, `_TEMPLATE.host.js`, `_TEMPLATE.js`.
- `core` (13): `app.js`, `aspect-warn.js`, `dock.js`, `emoji-pack.js`, `group-manager.js`, `message-bridge.js`, `storage-manager.js`, `telemetry.js`, `theme-engine.js`, `tile-api.js`, `tile-engine.js`, `ui-kit.js`, `ui-tooltip.js`.
- `defaults` (6): `aji-url-migration.js`, `default-layout.js`, `default-layout.json`, `layout-migration.js`, `timeout-migration.js`, `v5-data-migration.js`.
- `factory_layouts` (3): `Banana标准模式.json`, `Comfyui标准模式.json`, `PsDlink标准模式.json`.
- `factory_scenes` (1): `cyberpunk.json`.
- `host` (22): `ai-api.js`, `bootstrap-handlers.js`, `concurrency-pool.js`, `context-builder.js`, `fs-utils.js`, `high-risk-task-handlers.js`, `host-api.js`, `ipc.js`, `low-risk-handlers.js`, `misc-handlers.js`, `ps-io.js`, `ps-lock.js`, `ps-pixels.js`, `recordable-actions.js`, `recycle-bin.js`, `router.js`, `satellite-events.js`, `selection-flow-handlers.js`, `sound.js`, `stop-control-handlers.js`, `tile-host-loader.js`, `tile-scanner-handlers.js`.
- `styles` (8): `base.css`, `components.css`, `dock.css`, `expand-panels.css`, `groups.css`, `simple-mode.css`, `tiles.css`, `ui-kit.css`.
- `tiles` (114): `_order.json`, `tile-aistatus.css`, `tile-aistatus.host.js`, `tile-aistatus.js`, `tile-automation.host.js`, `tile-automation.js`, `tile-batch.host.js`, `tile-batch.js`, `tile-billing.css`, `tile-billing.js`, `tile-bodypreset.css`, `tile-bodypreset.js`, `tile-browser.css`, `tile-browser.host.js`, `tile-browser.js`, `tile-camera.css`, `tile-camera.js`, `tile-chat.css`, `tile-chat.host.js`, `tile-chat.js`, `tile-cloud.host.js`, `tile-codex.css`, `tile-codex.js`, `tile-colorgrade.css`, `tile-colorgrade.host.js`, `tile-colorgrade.js`, `tile-comfyui.css`, `tile-comfyui.host.js`, `tile-comfyui.js`, `tile-community-mock.css`, `tile-community-mock.js`, `tile-conversation.css`, `tile-conversation.host.js`, `tile-conversation.js`, `tile-dev-ruler.css`, `tile-dev-ruler.js`, `tile-dock.js`, `tile-drawer.css`, `tile-drawer.js`, `tile-firstrun-satellite.css`, `tile-firstrun-satellite.js`, `tile-firstrun-welcome.css`, `tile-firstrun-welcome.js`, `tile-forge.css`, `tile-forge.host.js`, `tile-forge.js`, `tile-history.js`, `tile-info.css`, `tile-info.js`, `tile-kao.css`, `tile-kao.host.js`, `tile-kao.js`, `tile-layout.css`, `tile-layout.host.js`, `tile-layout.js`, `tile-light.css`, `tile-light.js`, `tile-light.prompt-2d.js`, `tile-light.prompt-relight.js`, `tile-lighthand.host.js`, `tile-log.css`, `tile-log.js`, `tile-params.css`, `tile-params.js`, `tile-partition.host.js`, `tile-partition.js`, `tile-perf-monitor.css`, `tile-perf-monitor.js`, `tile-poster.css`, `tile-poster.host.js`, `tile-poster.js`, `tile-poster.prompts.js`, `tile-presets.host.js`, `tile-presets.js`, `tile-prompt.css`, `tile-prompt.js`, `tile-prompt-optimizer.css`, `tile-prompt-optimizer.host.js`, `tile-prompt-optimizer.js`, `tile-qa.css`, `tile-qa.data.js`, `tile-qa.js`, `tile-recyclebin.css`, `tile-recyclebin.host.js`, `tile-recyclebin.js`, `tile-refimages.js`, `tile-run.css`, `tile-run.host.js`, `tile-run.js`, `tile-satellite.css`, `tile-satellite.js`, `tile-scene.css`, `tile-scene.host.js`, `tile-scene.js`, `tile-scope.css`, `tile-scope.host.js`, `tile-scope.js`, `tile-settings.js`, `tile-support.css`, `tile-support.js`, `tile-sync.css`, `tile-sync.host.js`, `tile-sync.js`, `tile-tasks.host.js`, `tile-tasks.js`, `tile-tiled.host.js`, `tile-tiled.js`, `tile-topbar.css`, `tile-topbar.js`, `tile-translate.host.js`, `tile-update.css`, `tile-update.js`, `tile-welcome.css`, `tile-welcome.js`.

`_dev/` document coverage note:

- `_dev` Markdown files are not counted as runtime code, but their headings and major notes were scanned first as requested.
- Architecture/API/UI source docs: `_API-REFERENCE.md`, `DEV_NOTES.md`, `UI_SPEC.md`, `HOST_CODE_MAP.md`, `README.md`.
- Audit/risk/bug docs: `AUDIT_2026-04-30.md`, `AUDIT_2026-05-13.md`, `AUDIT_REPORT.md`, `BUG_LIST_PLAIN.md`, `SERVER_BUG_LIST_PLAIN.md`, `DEBUG_CHECKLIST.md`, `FIX_PLAN_FOR_HANDOFF.md`, `FIX_RISK_ASSESSMENT.md`.
- Release/migration/roadmap docs: `CHANGELOG.md`, `FEATURE_PARITY.md`, `MIGRATION_ROADMAP.md`, `PHASE2_ROADMAP.md`, `UPDATE_SYSTEM_NOTES.md`, `V6_RELEASE_GUIDE.md`.
- Feature-specific docs: `RECYCLEBIN_DESIGN.md`, `SCENE_TILE_NOTES.md`, `PROMPT_OPTIMIZER_SYSTEM_PROMPT.md`, `dreamy-prancing-wave.md`, `momo算力_账单磁贴_施工记录.md`, `算力槽位_施工清单.md`.
- Source code remains the final authority when `_dev` and implementation disagree.

## 0. Product Identity

- Product: 夏三七的修图轮椅 v6
- Current manifest version: `6.3.8`
- Manifest id: `com.xiasanqi.ps.wheelchair.v4`
- Manifest entry: `index.html`
- Host app: Photoshop, minVersion `26.0.0`
- Architecture generation: v6 tile system, not the old tab system.
- Important compatibility note: the manifest id intentionally remains v4 to preserve update/data continuity. Changing it creates a different UXP plugin and a different data folder.

Primary files:

- `manifest.json` - UXP metadata and permissions.
- `index.html` - UXP host entry; embeds the WebView panel.
- `panel.html` - WebView UI shell and core script bootstrap.
- `index.js` - host-side assembly, storage, PS context, router, menu, module wiring.
- `core/` - panel framework.
- `host/` - host framework and shared PS/IO/API services.
- `tiles/` - feature tiles and tile-local host actions.
- `_dev/` - development docs. Useful, but not always fully current.

## 1. Runtime Split

The plugin has two distinct runtimes.

### Host Runtime

Runs in the UXP/Photoshop host environment.

Main responsibilities:

- listen for messages from the WebView;
- route actions through `host/router.js`;
- operate Photoshop via DOM/batchPlay/imaging APIs;
- access UXP file system and `dataFolder`;
- call external APIs where panel-side fetch is unreliable or forbidden;
- persist `webview_storage.json`;
- load all `tiles/*.host.js` modules at startup.

Primary modules:

- `index.js`
- `host/router.js`
- `host/host-api.js`
- `host/context-builder.js`
- `host/tile-host-loader.js`
- `host/bootstrap-handlers.js`
- `host/low-risk-handlers.js`
- `host/selection-flow-handlers.js`
- `host/high-risk-task-handlers.js`
- `host/stop-control-handlers.js`
- `host/misc-handlers.js`
- `host/ps-io.js`
- `host/ps-pixels.js`
- `host/ai-api.js`
- `host/recycle-bin.js`
- `host/fs-utils.js`
- `host/ipc.js`
- `host/ps-lock.js`
- `host/sound.js`

### Panel Runtime

Runs in Chromium WebView.

Main responsibilities:

- draw the UI;
- own `TileAPI.state`;
- own immediate panel memory storage via `StorageManager`;
- register and render tiles;
- send host actions via `TileAPI.sendToHost`;
- consume host messages via `TileAPI.onHostMessage` or tile `onMessage`.

Primary modules:

- `panel.html`
- `core/app.js`
- `core/message-bridge.js`
- `core/storage-manager.js`
- `core/tile-api.js`
- `core/tile-engine.js`
- `core/group-manager.js`
- `core/theme-engine.js`
- `core/ui-kit.js`
- `core/dock.js`
- `core/emoji-pack.js`
- `core/telemetry.js`

Important boundary rule:

- Host and panel cannot share object references.
- Any data needed by host must be sent in the payload.
- Any panel state needed by host must be included by the caller.
- Host cannot read `TileAPI.state`; panel cannot call Photoshop APIs directly.

## 2. Boot Flow

### 2.1 Static Boot

`panel.html` loads:

1. default/migration scripts;
2. `core/storage-manager.js`;
3. `core/message-bridge.js`;
4. `core/ui-kit.js`;
5. `core/tile-api.js`;
6. tooltip/aspect/theme/group/tile engines;
7. telemetry, emoji, dock;
8. `tiles/tile-welcome.js`;
9. `core/app.js`.

Only the welcome tile is hardcoded. All other tiles are dynamically discovered.

### 2.2 App Boot

`core/app.js`:

1. initializes `MessageBridge`, `ThemeEngine`, `TileEngine`;
2. bridges cloud compute host messages into `TileAPI.compute`;
3. installs global host-message forwarders;
4. sends `ready` to host;
5. waits for `storageLoaded`;
6. restores theme and runs storage migrations;
7. shows telemetry opt-in and welcome overlay;
8. sends `scanTiles`;
9. injects tile CSS/JS from host scan results;
10. renders groups and tiles;
11. calls each tile `onStorageLoaded`;
12. emits `app:ready`;
13. starts optional update auto-check and telemetry.

### 2.3 Tile Discovery

Panel:

- sends `scanTiles`;
- receives `tilesList`;
- injects CSS first, then JS in order.

Host:

- `host/tile-scanner-handlers.js` scans `tiles/`;
- JS order is controlled by `tiles/_order.json`;
- `tile-welcome.js` is skipped because it is already loaded.

### 2.4 Host Action Discovery

At host startup:

- `host/tile-host-loader.js` scans all `tiles/*.host.js`;
- each file calls `HostAPI.registerAction(...)`;
- `host/router.js` dispatches registered HostAPI actions first;
- legacy handler chain runs only if HostAPI has no matching action.

## 3. Message Flow

Panel to host:

```js
TileAPI.sendToHost(action, data)
```

Under the hood:

```txt
TileAPI.sendToHost
  -> MessageBridge.sendToHost
  -> WebView postMessage
  -> index.js host listener
  -> host/router.js
  -> HostAPI action or legacy handler
```

Host to panel:

```js
ctx.sendToPanel(action, data)
```

Under the hood:

```txt
index.js sendToPanel
  -> webview.postMessage({ source:'host', action, data })
  -> MessageBridge host handlers
  -> TileAPI.onHostMessage listeners
  -> global tile onMessage broadcast
```

Important:

- Host messages are broadcast to all registered tile `onMessage` handlers by `core/app.js`.
- Request/response style messages should include request IDs, task IDs, translate IDs, etc.
- `TileAPI.onHostMessage` currently has no common off API in many usage sites; long-lived/module-level listeners must be treated carefully.

## 4. Storage Map

### 4.1 Panel Storage

`core/storage-manager.js`:

- keeps `_memoryStore`;
- reads/writes `localStorage` as a short-term mirror;
- forwards `storageSet` and `storageRemove` to host.

### 4.2 Host Storage

`index.js` persists panel storage to:

```txt
dataFolder/webview_storage.json
dataFolder/webview_storage.json.writing
dataFolder/webview_storage.json.bak
```

Key design:

- plugin folder is read-only for runtime writes;
- all runtime data belongs in UXP `dataFolder`;
- host storage is loaded immediately at startup;
- writes are atomic-ish with `.writing` and `.bak`;
- `storageSet` waits for storage readiness before mutating in-memory host storage.

### 4.3 Persistent Data Folders

Typical dataFolder subfolders/files:

- `webview_storage.json`
- `cloud_setting.json`
- `cloud_user.json`
- `image_cache/`
- `recycle_bin/`
- `presets/`
- `forge_presets/`
- `chat_data/`
- satellite/browser IPC/config folders where applicable.

## 5. Tile Framework

### 5.1 TileAPI

`core/tile-api.js` provides:

- `TileAPI.registerTile(def)`
- `TileAPI.getTileDef(id)`
- `TileAPI.getAllTiles()`
- `TileAPI.on/off/emit`
- `TileAPI.state.get/set/subscribe`
- `TileAPI.storage.get/set/remove`
- `TileAPI.sendToHost`
- `TileAPI.onHostMessage`
- `TileAPI.confirm/dialog/prompt/toast`
- `TileAPI.compute.*`
- `TileAPI.slotLabel/slotShort/slotOrder/slotOrderAll`
- `TileAPI.taskBadge`

State vs storage:

- `TileAPI.state` is runtime-only.
- `TileAPI.storage` persists through host to dataFolder.
- Use events for semantic cross-tile notifications.

### 5.2 TileEngine

`core/tile-engine.js` owns:

- 4-column tile grid;
- cell sizing;
- drag and resize;
- push/collision behavior;
- fullscreen expand;
- inline expand;
- panel mode;
- tile color picker;
- layout save/restore;
- edit toolbar;
- layout migrations for old topbar rows;
- pinTop detachment behavior.

Important behavior:

- `pinTop` tiles are moved to `#topbarHost` and do not occupy the main grid.
- tiles larger than 1x1 enter panel mode.
- 1x1 tiles may use inline or fullscreen expand.
- all modes call tile `onExpand(container, sizeHint)`.
- `onExpand` cleanup functions are stored as `_panelCleanup`, `_inlineCleanup`, or `_expandCleanup`.

Layout tiers:

- `narrow`
- `tall`
- `square`
- `wideshort`
- `wide`

Every substantial tile should render all expected size tiers.

### 5.3 GroupManager

`core/group-manager.js` owns:

- `#topbarHost`;
- layout button and layout panel host;
- `#mainGrid`;
- folders;
- folder tile rendering;
- moving tiles into/out of folders.

Folder storage key:

- `__tile_folders_v6`

### 5.4 UIKit

`core/ui-kit.js` provides:

- custom select replacement;
- modal dialog;
- confirm;
- alert;
- prompt;
- popup cleanup.

Use `TileAPI.confirm/dialog/prompt`, not native `confirm/alert/prompt`.

## 6. Current Tile Inventory

Tiles are loaded in `tiles/_order.json` order, with unlisted files appended alphabetically.

### Primary Workflow Tiles

| Tile id | File | Purpose |
|---|---|---|
| `topbar` | `tiles/tile-topbar.js` | pinned account/compute/connection topbar |
| `prompt` | `tiles/tile-prompt.js` | prompt and preset-derived prompt editing |
| `prompt-optimizer` | `tiles/tile-prompt-optimizer.js` | AI prompt optimization |
| `poster` | `tiles/tile-poster.js` | GPT-image poster/layout generation |
| `params` | `tiles/tile-params.js` | model/provider/size/batch/aspect/timeout |
| `refimages` | `tiles/tile-refimages.js` | reference images |
| `run` | `tiles/tile-run.js` | start generation / repeat / add to batch |
| `tasks` | `tiles/tile-tasks.js` | running/pending tasks, return, stop |
| `batch` | `tiles/tile-batch.js` | batch queue |
| `history` | `tiles/tile-history.js` | prompt/generation history |
| `recyclebin` | `tiles/tile-recyclebin.js` | persistent task archive |
| `conversation` | `tiles/tile-conversation.js` | conversation-style generation history |
| `presets` | `tiles/tile-presets.js` | preset browser/editor |
| `bodypreset` | `tiles/tile-bodypreset.js` | body silhouette preset picker |

### Engines and Advanced Tools

| Tile id | File | Purpose |
|---|---|---|
| `forge` | `tiles/tile-forge.js` | SD WebUI Forge integration |
| `comfyui` | `tiles/tile-comfyui.js` | ComfyUI workflow integration |
| `camera` | `tiles/tile-camera.js` | 3D camera angle + AI reconstruction |
| `light` | `tiles/tile-light.js` | 2D/3D lighting editor + AI reconstruction |
| `scene` | `tiles/tile-scene.js` | scene package generation |
| `colorgrade` | `tiles/tile-colorgrade.js` | AI color grading by reference image |
| `kao` | `tiles/tile-kao.js` | VFX particle effects |
| `partition` | `tiles/tile-partition.js` | global multi-document partition generation |
| `tiled` | `tiles/tile-tiled.js` | tiled upscale |
| `scope` | `tiles/tile-scope.js` | waveform/RGB/vector/histogram scope |

### System, Support, and Utility Tiles

| Tile id | File | Purpose |
|---|---|---|
| `sync` | `tiles/tile-sync.js` | cloud preset sync/import |
| `layout` | `tiles/tile-layout.js` | layout snapshots; registered noGrid |
| `update` | `tiles/tile-update.js` | update check/download/install |
| `support` | `tiles/tile-support.js` | online support |
| `qa` | `tiles/tile-qa.js` | help/FAQ |
| `chat` | `tiles/tile-chat.js` | AI assistant |
| `log` | `tiles/tile-log.js` | runtime log |
| `drawer` | `tiles/tile-drawer.js` | stash uncommon tiles |
| `settings` | `tiles/tile-settings.js` | output, appearance, sound, telemetry settings |
| `info` | `tiles/tile-info.js` | diagnostic/version/status info |
| `billing` | `tiles/tile-billing.js` | compute billing and Momo billing |
| `satellite` | `tiles/tile-satellite.js` | remote satellite plugin control |
| `browser` | `tiles/tile-browser.js` | separate browser plugin install/config |
| `aistatus` | `tiles/tile-aistatus.js` | AI service status |
| `dock` | `tiles/tile-dock.js` | right-side shortcut Dock settings |
| `dev-ruler` | `tiles/tile-dev-ruler.js` | developer width ruler |
| `perf-monitor` | `tiles/tile-perf-monitor.js` | FPS/memory/render monitor |
| `codex` | `tiles/tile-codex.js` | Codex automation/security context |
| `community-mock` | `tiles/tile-community-mock.js` | community waterfall mock/perf test |

## 7. Host Action Map

HostAPI actions are tile-local when possible.

### Cloud and Account

`tiles/tile-cloud.host.js`:

- `cloudLogin`
- `cloudRegister`
- `cloudLogout`
- `cloudGetCaptcha`
- `cloudRestoreSession`
- `cloudGetAnnouncement`
- `cloudGetUserPoints`
- `cloudRechargeCardKey`
- `cloudComputeGetKey`
- `cloudComputeRefill`
- `cloudComputeSync`
- `cloudComputeSetByok`
- `cloudGetForgeUrl`
- `cloudTestForgeConnection`
- `cloudForgeProbe`
- `cloudForgeImg2Img`
- `cloudConsumePoints`
- `cloudResetPasswordByCard`

### Banana/API Generation and Tasks

`tiles/tile-run.host.js`:

- `runSingle`
- `recordableRunSingle`

`tiles/tile-tasks.host.js`:

- `setTaskAutoReturn`
- `clearTaskCache`
- `returnTaskResult`
- `grsCheckCredits`
- `checkQuota`
- `calibrateBalance`
- `checkMomoQuota`
- `momoBilling`
- `momoFetchModels`
- `getMomoLink`

### Presets and Prompt

`tiles/tile-presets.host.js`:

- `loadPresetsFile`
- `savePresetsFile`
- `openPresetFolder`
- `refreshPresets`
- `exportPreset`
- `importPreset`

`tiles/tile-prompt-optimizer.host.js`:

- `promptOptimize`

`tiles/tile-translate.host.js`:

- `youdaoTranslate`

### Forge

`tiles/tile-forge.host.js`:

- `forgeTestConnection`
- `forgeFetchModels`
- `forgeFetchSamplers`
- `forgeFetchControlNetModules`
- `forgeFetchControlNetModels`
- `forgeFetchLoras`
- `forgeImg2Img`
- `forgeTxt2Img`
- `forgeInterrupt`
- `loadForgePresetsFile`
- `saveForgePresetsFile`
- `openForgePresetFolder`
- `refreshForgePresets`

### ComfyUI

`tiles/tile-comfyui.host.js`:

- `comfyConnect`
- `comfyFetchWorkflows`
- `comfyLoadWorkflow`
- `comfyGenerate`
- `comfyInterrupt`
- `comfyOpenFolder`

### Advanced Image Workflows

`tiles/tile-colorgrade.host.js`:

- `captureRefImageForColorgrade`
- `colorGradeTask`

`tiles/tile-kao.host.js`:

- `kaoVfxTask`

`tiles/tile-partition.host.js`:

- `startGlobalPartition`
- `confirmGlobalPartitionYes`

`tiles/tile-tiled.host.js`:

- `startTiledUpscale`
- `confirmTiledUpscaleYes`
- `tiledFillTest`

`tiles/tile-lighthand.host.js`:

- `lightHandPlace`

`tiles/tile-scene.host.js`:

- `sceneListPacks`
- `sceneCaptureRef`
- `sceneGenerate`

`tiles/tile-scope.host.js`:

- `scopeInit`
- `scopeGrabPixels`

### Poster

`tiles/tile-poster.host.js`:

- `posterCaptureFromPS`
- `posterGenerate`
- `posterAutofill`
- `posterPromptsLoad`
- `posterPromptsSave`
- `posterPromptsResetCategory`
- `posterReportUsage`

### Recycle Bin

`tiles/tile-recyclebin.host.js`:

- `recycleListItems`
- `recycleGetImage`
- `recyclePlaceToPS`
- `recycleDelete`
- `recycleClear`

### Conversation and Chat

`tiles/tile-conversation.host.js`:

- `conversationSaveImage`
- `conversationCleanup`
- `conversationOpenFolder`
- `conversationLayerVisibility`
- `gotoLayerMask`

`tiles/tile-chat.host.js`:

- `saveChatData`
- `loadChatData`

### Layout and Sync

`tiles/tile-layout.host.js`:

- `layoutScan`
- `layoutLoad`
- `layoutSaveUser`
- `layoutDeleteUser`
- `layoutOpenUserFolder`

`tiles/tile-sync.host.js`:

- `syncFetchList`
- `syncFetchManifest`
- `syncFetchOne`

### External Helpers

`tiles/tile-browser.host.js`:

- `checkBrowserStatus`
- `installBrowser`
- `openBrowserFolder`
- `ipcWriteBrowserConfig`

`tiles/tile-aistatus.host.js`:

- `aistatusFetch`
- `aistatusOpenCodeFile`

`tiles/tile-automation.host.js`:

- `autoBootstrap`
- `autoWriteResult`
- `ipcWriteCodexProfile`

## 8. Legacy Handler Map

Some framework-level and shared actions still live in legacy handlers.

`host/bootstrap-handlers.js` generally owns:

- `ready`
- `ping`
- storage load/set/remove/flush;
- update download/install support;
- AJI URL validation;
- settings updates;
- basic doc/info and startup actions.

`host/selection-flow-handlers.js` generally owns:

- capture reference image;
- recapture main/reference image;
- restore selection;
- marquee aspect sync.

`host/stop-control-handlers.js` generally owns:

- early stop;
- early stop by task;
- timeout extension;
- abort controller cleanup.

`host/misc-handlers.js` generally owns:

- opening external URLs/folders;
- cache cleanup;
- sound preview/play;
- miscellaneous low-risk UXP shell operations.

Rule:

- New tile-specific business should usually be a `tiles/tile-name.host.js` HostAPI action.
- Framework/shared actions can stay in host legacy handlers.

## 9. Main Generation Flow

### 9.1 Banana/API Path

```txt
tile-prompt / tile-presets / tile-params / tile-refimages
  -> tile-run.js
  -> TileAPI.sendToHost('runSingle', payload)
  -> tiles/tile-run.host.js
  -> ctx.getSelectionAndImage()
  -> ctx.callAiApi()
  -> host/ai-api.js
  -> ctx.archiveToRecycleBin()
  -> ctx.sendToPanel('taskProgress' / 'taskComplete')
  -> tile-tasks.js
  -> tile-billing.js listens generate:complete
```

Panel-side `tile-run.js` creates `tasks.running` and `tasks.meta` immediately so the UI can show a task card before host work completes.

Host-side `tile-run.host.js`:

- captures PS selection/input image;
- optionally handles ref images;
- builds archive metadata;
- creates pending recycle-bin entries;
- calls `ctx.callAiApi`;
- saves image cache;
- places result back if auto-return is enabled;
- sends `taskProgress` and `taskComplete`.

### 9.2 Forge Path

`tile-run.js` checks `prompt.lastPresetKind`.

- banana/default -> `runSingle`
- forge -> `window._forgeStartGenerateViaRun({ taskId })`

`tiles/tile-forge.js` owns:

- local/cloud source selection;
- Forge URL/model/sampler/ControlNet/Lora state;
- direct generate button;
- unified run-button entry through `_forgeStartGenerateViaRun`.

Forge host:

- `forgeImg2Img`
- `forgeTxt2Img`
- `cloudForgeImg2Img`
- `forgeInterrupt`

Forge stopping is not the same as Banana:

- Banana early stop can abort host request.
- Forge stop mainly hides/stops tracking in frontend; host may continue until response.

### 9.3 Specialized Workflows

Some advanced tiles use `recordableRunSingle` or their own host action:

- `tile-light.js` -> `recordableRunSingle` or `lightHandPlace`
- `tile-camera.js` -> `recordableRunSingle`
- `tile-colorgrade.js` -> `colorGradeTask`
- `tile-kao.js` -> `kaoVfxTask`
- `tile-scene.js` -> `sceneGenerate`
- `tile-tiled.js` -> `startTiledUpscale`
- `tile-partition.js` -> `startGlobalPartition`
- `tile-poster.js` -> `posterGenerate`

They often still write task cards into `tasks.running` so `tile-tasks` can show progress.

## 10. Task System

Runtime state:

- `tasks.running`
- `tasks.pending`
- `tasks.meta`
- `tasks.metrics`
- `tasks.lastSuccessTime`

Persistent stats:

- `tasks.stats.today`
- `tasks.stats.lastTime`

Important host messages:

- `taskStarted`
- `previewImage`
- `taskProgress`
- `forgeProgress`
- `taskComplete`
- `taskReturned`
- `taskAutoReturnFailed`
- `taskManualReturnFailed`

Important panel events:

- `tasks:updated`
- `tasks:tick`
- `tasks:progress`
- `task:started`
- `generate:started`
- `generate:complete`

`generate:complete` is important for:

- billing ledger;
- telemetry;
- history;
- downstream UI badges.

## 11. Recycle Bin System

Persistent module:

- `host/recycle-bin.js`

Data location:

```txt
dataFolder/recycle_bin/
```

Concept:

- all task outcomes may be archived;
- successful image outputs are stored as PNG/base64-backed files;
- failed/aborted tasks can still have metadata;
- pending entries are inserted at task start and updated later;
- soft-stop/late-complete behavior is expected.

Frontend:

- `tiles/tile-recyclebin.js`

Host actions:

- `recycleListItems`
- `recycleGetImage`
- `recyclePlaceToPS`
- `recycleDelete`
- `recycleClear`

Smart restore requires:

- original document context;
- saved selection bounds;
- image data;
- open original document.

If the original document is closed or context is missing, restore should reject rather than guess.

## 12. Compute Providers

Canonical provider engines:

- `aji`
- `grs`
- `momo`
- `others`

Important:

- Use `TileAPI.slotOrder()` for visible provider choices. It returns the first 3.
- Use `TileAPI.slotOrderAll()` only where all 4 providers must be managed.
- Do not hardcode `aji/grs/others` lists in new UI.
- Do not alter true model IDs; display names can change, request IDs must remain real IDs.

### 12.1 Slot Config

Storage/state:

- `compute.slots`
- `compute.models`
- `models.others.cache`
- `models.momo.cache`
- `models.<provider>` state views

Helpers:

- `TileAPI.slotLabel(engine, fallback)`
- `TileAPI.slotShort(engine, fallback)`
- `TileAPI.slotOrder()`
- `TileAPI.slotOrderAll()`

### 12.2 AJI

Storage:

- `connection.aji.key`
- `connection.aji.url`
- `connection.aji.urlList`

Behavior:

- URL validation/probing occurs through host.
- Some default URLs are fetched through server or fallback list.
- Balance can be checked through `/api/usage/token`.

### 12.3 GRS / Summer Compute

Storage:

- `connection.grs.url`
- `connection.grs.key`
- `connection.grs.use_byok`

Runtime state:

- `compute.mode`
- `compute.key`
- `compute.status`
- `compute.cap`
- `compute.balance`
- `grs.credits`
- `grs.modelStatuses`

Modes:

- BYOK: user-provided GRS key.
- proxy: cloud account receives server-managed subkey.

Helpers:

- `TileAPI.compute.getKey`
- `TileAPI.compute.refill`
- `TileAPI.compute.sync`
- `TileAPI.compute.setByok`
- `TileAPI.compute.isUserByokActive`
- `TileAPI.computeBrand`

### 12.4 Momo

Storage:

- `connection.momo.key`
- `models.momo.cache`
- `momo.buyUrl`
- `momo.buyTitle`

Fixed base URL:

```txt
https://api.momoapi.icu
```

Host actions:

- `checkMomoQuota`
- `momoBilling`
- `momoFetchModels`
- `getMomoLink`

Important:

- Momo panel fetches must go through host.
- Momo follows the "others-like" Bearer route in `host/ai-api.js`.
- Current docs mark Momo request compatibility as needing real-world verification.

### 12.5 Others

Storage:

- `connection.others.configs`
- `connection.others.url`
- `connection.others.key`
- `models.others.cache`

Supports multiple configs in topbar/settings.

## 13. AI API Client

`host/ai-api.js` owns provider-specific generation behavior.

Provider differences:

- AJI: Bearer, image edit route, some suffix behavior.
- GRS: custom GPT-image draw endpoint and polling path.
- Others: generic intermediary route.
- Momo: currently treated like Others with fixed URL and Bearer.

Critical details:

- `callAiApi` supports archive callbacks for soft-stop/archive behavior.
- error messages are sanitized before telemetry/logging.
- usage reporting URL currently points to cpolar and must be changed before public release.
- prompt/model/size/aspect are passed by the caller; host does not consult panel state.

## 14. Photoshop IO

`host/ps-io.js` owns:

- selection detection;
- full-canvas fallback if enabled;
- image capture through `photoshop.imaging`;
- 16/32-bit conversion handling;
- color-stable mode;
- smart object/pixel placement;
- group and mask creation;
- return feather mask;
- selection restore;
- reference capture;
- chat capture;
- teaching-material generation;
- marquee aspect preset sync/import.

Global PS locking:

- `host/ps-lock.js`
- used to avoid competing `executeAsModal` operations.

Important:

- PS property access can throw. Many defensive try/catch blocks are intentional.
- Avoid periodic `executeAsModal`; it can cause document flicker or block users.

## 15. Major UI/Feature Modules

### 15.1 Topbar

`tiles/tile-topbar.js`

Owns:

- account login/register/logout;
- captcha;
- recharge;
- cloud points;
- GRS compute mode and key;
- AJI/GRS/Others/Momo configuration;
- slot names/order/model visibility;
- Momo model fetch and quota;
- cloud Forge URL selection/test;
- layout panel toggle.

Exports globals:

- `window._cloudIsLoggedIn`
- `window._cloudIsReady`
- `window._cloudGetPoints`
- `window._cloudIsForgeConnected`
- `window._cloudGetForgeEncrypted`
- `window._cloudGetForgeUrlList`
- `window._cloudGetForgeSelectedIdx`
- `window._cloudSetForgeSelectedIdx`
- `window._topbarToggleLayoutPanel`

Risk:

- Very large and high-impact file.
- Do not casually refactor.

### 15.2 Params

`tiles/tile-params.js`

Owns:

- provider selection;
- model views;
- size/aspect/batch/timeout;
- anti-truncation mode;
- marquee aspect sync;
- model fetch for Others;
- compute slot view generation.

Exports:

- `TileAPI.rebuildModelViews`

Important:

- It rebuilds `models.<provider>` views from full catalogs and user slot/model config.
- Hidden or filtered models must not alter true model IDs.

### 15.3 Prompt and Presets

`tiles/tile-prompt.js`

Owns:

- prompt text state;
- preset head display;
- parameterized prompt editing;
- Forge prompt sync;
- translate requests.

Key state:

- `prompt.text`
- `prompt.lastPresetTitle`
- `prompt.lastPresetKind`
- `prompt.lastPresetId`
- `prompt.lastPresetMeta`

`tiles/tile-presets.js`

Owns:

- preset list/import/export/save/delete;
- factory/user preset loading;
- body preset filtering;
- Forge preset application;
- emits `prompt:changed`, `preset:loaded`, `forge:applyPreset`.

### 15.4 Forge

`tiles/tile-forge.js`

Owns:

- local/cloud source;
- Forge connection;
- model/sampler/CN/Lora fetch;
- Forge presets;
- prompt sync with prompt tile;
- generation entry for its own button and run tile.

Exports:

- `window._forgeIsConnected`
- `window._forgeGetPresets`
- `window._forgeStartGenerateViaRun`
- `window._forgeGetActiveSource`

### 15.5 Poster

`tiles/tile-poster.js`
`tiles/tile-poster.prompts.js`

Owns:

- poster prompt templates;
- prompt editor;
- PS capture/upload slots;
- autofill;
- GPT-image generation;
- usage reporting.

Host:

- `tiles/tile-poster.host.js`

Risk:

- Large file and external-server dependent.
- Several proxy URLs currently point to cpolar.

### 15.6 Light and Camera

`tiles/tile-light.js`

Owns:

- 2D hand-drawn lighting;
- 3D light state;
- relight prompt;
- provider/model settings;
- generation via `recordableRunSingle`;
- placement of hand-drawn light layer.

`tiles/tile-camera.js`

Owns:

- 3D camera UI;
- provider/model settings;
- generation via `recordableRunSingle`.

Risk:

- Some onHostMessage listeners can accumulate if registered inside repeated UI paths.

### 15.7 Conversation and Satellite

`tiles/tile-conversation.js`

Owns:

- conversation messages;
- saved generated images;
- layer visibility/solo controls;
- translation of conversation text;
- cleanup of stale images.

Storage:

- `conversation.messages`

`core/app.js` periodically writes satellite IPC state:

- task state;
- current params;
- recent conversation thumbnails.

`tiles/tile-satellite.js` owns satellite install/status/config UI.

## 16. External Services and URLs

Critical current issue:

- many production-facing URLs still point to `https://xiasanqi.cpolar.top`.
- `_dev/DEBUG_CHECKLIST.md` marks this as P0 before public release.

Known cpolar occurrences include:

- `login-service.js`
- `host/ai-api.js`
- `host/bootstrap-handlers.js`
- `core/telemetry.js`
- `tiles/tile-aistatus.host.js`
- `tiles/tile-poster.host.js`
- `tiles/tile-prompt-optimizer.host.js`
- `tiles/tile-run.host.js`
- `tiles/tile-sync.host.js`
- `tiles/tile-support.js`
- `tiles/tile-tasks.host.js`
- `tiles/tile-update.js`

Other external APIs:

- Momo: `https://api.momoapi.icu`
- Youdao translate: hardcoded credentials in `tiles/tile-translate.host.js`
- AJI/GRS/Others user-provided or server-fetched endpoints.

## 17. Update System

Frontend:

- `tiles/tile-update.js`

Host:

- `host/bootstrap-handlers.js`
- `update_plugin.bat`

Flow:

```txt
tile-update checks /api/update/check
  -> receives version/downloadUrl/sha256
  -> sendToHost('downloadUpdate', { url, expectedSha256 })
  -> host downloads zip to dataFolder
  -> optional sha256 validation
  -> copies update_plugin.bat to dataFolder
  -> sends updateReady
  -> frontend sends launchUpdateBat
  -> host launches updater
```

Current code includes sha256 support when server supplies it.

## 18. Layout System

Default layout:

- `defaults/default-layout.js`

User layout:

- storage key `__tile_layout_v6`

Expand modes:

- storage key `__tile_expand_modes`

Tile colors:

- storage key `__tile_colors`

Folders:

- storage key `__tile_folders_v6`

Drawer:

- storage key `__tile_drawer_stash_v6`

Layout snapshots:

- `tiles/tile-layout.js`
- `tiles/tile-layout.host.js`
- factory layouts in `factory_layouts/`

Note:

- default layout still contains old `balance`/`cloud` entries, but `TileEngine.restoreLayout` strips obsolete keys.

## 19. UI Development Rules

Use:

- `.w10-panel`
- `.w10-section-title`
- `.w10-row`
- `.w10-row-left`
- `.w10-row-right`
- `.w10-row-label`
- `.w10-row-desc`
- `.w10-btn`
- `.w10-btn-accent`
- `.w10-input`
- `.w10-select`
- `.w10-toggle`
- `.w10-slider`
- `.w10-tag`

Do:

- guard all DOM queries;
- return cleanup from `onExpand` when binding events;
- use `TileAPI.confirm/dialog/prompt`;
- use `TileAPI.toast` for transient messages;
- use `container.querySelector`, not global document queries, inside panel renderers;
- pass `sizeHint.layout` through renderer decisions.

Avoid:

- native `confirm/alert/prompt`;
- `transition: all`;
- writing runtime files into plugin folder;
- binding persistent events in `renderFront`;
- replacing UIKit-bound select elements with `outerHTML`;
- hardcoding provider order;
- hardcoding true model IDs under display names;
- long synchronous work in `onExpand`;
- sending sensitive values to console.

## 20. Important Event Map

Common lifecycle:

- `app:storageLoaded`
- `app:ready`
- `tile:expanded`
- `tile:collapsed`
- `tile:inlineExpanded`
- `tile:inlineCollapsed`
- `editMode:enter`
- `editMode:exit`
- `state:changed`

Prompt/preset:

- `prompt:changed`
- `prompt:forceText`
- `preset:loaded`
- `presets:changed`
- `presets:requestSaveDialog`
- `bodypreset:select`

Params/provider:

- `params:providerChanged`
- `params:remoteChanged`
- `params:antiModeChanged`
- `params:modelsFetched`
- `compute:keyUpdated`
- `compute:syncResult`
- `compute:byokResult`
- `compute:byokPrefChanged`

Tasks:

- `run:start`
- `run:addToBatch`
- `run:repeatLast`
- `task:started`
- `tasks:updated`
- `tasks:tick`
- `tasks:progress`
- `generate:started`
- `generate:complete`

Output/settings:

- `output:autoReturnChanged`
- `output:autoGroupChanged`
- `settings:providerChanged`

Cloud/auth:

- `auth:loggedIn`
- `auth:loggedOut`
- `cloud:pointsReady`
- `cloud:forgeUrlListChanged`

Forge:

- `forge:applyPreset`
- `forge:sourceChanged`
- `forge:syncFromPrompt`
- `forge:syncToPrompt`
- `forge:paramsChanged`
- `forge:tileChanged`

Reference/conversation:

- `refimages:updated`
- `conversation:updated`

## 21. High-Risk Files

Treat these as high-risk because they are large, central, or cross-cutting:

- `core/tile-engine.js`
- `core/app.js`
- `core/tile-api.js`
- `tiles/tile-topbar.js`
- `tiles/tile-params.js`
- `tiles/tile-poster.js`
- `tiles/tile-light.js`
- `tiles/tile-forge.js`
- `tiles/tile-prompt.js`
- `tiles/tile-tasks.js`
- `tiles/tile-run.host.js`
- `host/ps-io.js`
- `host/ai-api.js`
- `index.js`
- `login-service.js`

Before changing these:

1. search event/message usage;
2. check storage keys;
3. check task/recycle interactions;
4. verify provider compatibility;
5. avoid broad refactors unless requested.

## 22. Known Risks and Open Issues

P0 before public release:

- replace all cpolar URLs with official production domain;
- ensure update/check/download/install path uses final domain and hash;
- confirm Momo API request format in real environment.

Security/privacy:

- Youdao key/secret are hardcoded in `tiles/tile-translate.host.js`.
- XOR key for cloud Forge URL is hardcoded in `login-service.js`.
- Some cloud host logs may expose token or decrypted URL fragments.
- Login UI still stores `login.savedPassword` in panel storage when remember behavior is used; host-side cloud_setting password cleanup exists, but panel storage should be reviewed.

Reliability:

- Some `TileAPI.onHostMessage` registrations can accumulate across repeated expands.
- Some native `confirm()` uses remain per `_dev/DEBUG_CHECKLIST.md`.
- Some docs in `_dev/` refer to older incomplete update/migration states; source is the authority.
- `tile-engine.js` is monolithic and fragile.

Performance:

- satellite IPC loop runs frequently;
- large canvas tiles need careful devicePixelRatio/cache handling;
- avoid repeated DOM rebuilds in inline panels;
- avoid panel-side large base64 writes in high-frequency paths.

## 23. Development Playbook

When adding a new tile:

1. create `tiles/tile-name.js`;
2. optionally create `tiles/tile-name.css`;
3. optionally create `tiles/tile-name.host.js`;
4. register UI through `TileAPI.registerTile`;
5. register host actions through `HostAPI.registerAction`;
6. add file to `tiles/_order.json` only if load order matters;
7. use `.w10-*` UI;
8. use cleanup returns from `onExpand`;
9. keep storage keys namespaced;
10. include request IDs for async host responses.

When adding provider-aware UI:

1. use `TileAPI.slotOrder()` for visible choices;
2. use `TileAPI.slotOrderAll()` for config/billing/all-provider views;
3. use `TileAPI.slotLabel`;
4. use `TileAPI.slotShort` for badges;
5. read models from `TileAPI.state.get('models.' + provider)`;
6. do not hardcode AJI/GRS/Others-only assumptions.

When adding generation-like features:

1. create a task ID;
2. write `tasks.running` and `tasks.meta`;
3. emit `task:started` and `tasks:updated`;
4. send host action with complete payload;
5. send host progress with taskId;
6. send `taskComplete`;
7. archive outputs if applicable;
8. emit or rely on `generate:complete` for billing/telemetry/history.

When touching host code:

1. keep PS operations inside `executeAsModal` where required;
2. use PS lock for competing document operations;
3. write files only to dataFolder;
4. sanitize logs and errors;
5. wrap async host handlers in try/catch;
6. send explicit success/failure result messages.

## 24. Quick Search Anchors

Useful searches:

```txt
TileAPI.registerTile(
HostAPI.registerAction(
TileAPI.emit(
TileAPI.on(
TileAPI.sendToHost(
TileAPI.onHostMessage(
TileAPI.state.set(
TileAPI.storage.set(
sendToPanel(
SERVER_HOST_SWITCH
AUTH_HOST_SWITCH
cpolar
slotOrder
slotOrderAll
archiveToRecycleBin
generate:complete
```

## 25. Source of Truth Priority

Use this order when references disagree:

1. current source code;
2. `_dev/DEBUG_CHECKLIST.md` for known open risks;
3. `_dev/DEV_NOTES.md` for hard-learned implementation rules;
4. `_dev/UI_SPEC.md` for UI conventions;
5. `_dev/_API-REFERENCE.md` for API shape, with source verification;
6. `knowledge_base/` and `skills/` only for user-facing help, not implementation truth.

## 26. Full-Scan Addendum

This section records modules that were easy to understate in a high-level architecture map but are present in the 181-file coverage set.

### 26.1 Root Edge Files

`workflow-engine.js`

- Standalone ComfyUI workflow conversion/execution engine.
- Owns `object_info` fetching/cache, LiteGraph widget parsing, PrimitiveNode/Reroute/Note handling, LiteGraph-to-API prompt conversion, prompt submission, polling, output-image extraction, image download, and image upload.
- Exports functions through `module.exports`; it is not a TileAPI tile.

`wheelchair-tutorial.html`

- Standalone tutorial/mock UI, separate from UXP runtime boot.
- Simulates tile surface, tasks/history/chat/balance/cloud, tour steps, and progress so users can learn workflows without touching the real panel.

Install/update scripts:

- `install_browser.bat` installs or updates the companion browser package.
- `install_satellite.bat` installs or updates the satellite/remote-control package.
- `update_plugin.bat` performs the Windows-side plugin update copy/restart flow after host downloads an update.

Root config:

- `manifest.json` is UXP metadata and permissions.
- `builtin_roles.json` is built-in chat/assistant role data.
- `index.html` is the UXP host entry; `panel.html` is the WebView shell.

### 26.2 Batch Host Actions

`tiles/tile-batch.host.js` registers:

- `addToBatch`
- `runBatch`

These actions are part of the same generation/task surface as `tile-run.host.js`, but they are owned by the batch tile. `recordable-actions.js` can route Photoshop Action playback into add-to-batch behavior.

### 26.3 Automation and Codex Autopilot

`tiles/tile-automation.js`

- Headless panel bridge, loaded by `scanTiles` but registering no visible tile.
- Starts host polling through `autoBootstrap`.
- Receives `autoCommand` and dispatches panel-only commands that need `TileAPI`, DOM, state, storage, prompt state, task state, or conversation data.
- Exposes `window._automationRegister(action, fn)` for future command extension.

Panel automation command surface includes:

- `pingPanel`
- `getPromptMode`
- `ensurePromptTextMode`
- `clearPromptPresetBinding`
- `setPromptText`
- `setParams`
- `setAutoReturn`
- `runGenerate`
- `getTaskStatus`
- `getReturnedCandidates`
- `soloCandidate`
- `selectCandidate`
- `getCodexAutopilotProfile`
- `setCodexAutopilotProfile`
- `getAllowedModels`
- `validateModelPermission`

`tiles/tile-automation.host.js`

- Host bridge for Codex automation.
- Uses `wheelchair_ipc/automation_command.json` and `wheelchair_ipc/automation_result.json`.
- Writes per-request result files under `wheelchair_ipc/auto_out/`.
- Polls every 50ms after `autoBootstrap` captures `ctx.sendToPanel`.
- Serializes host commands with `_busy` to avoid concurrent Photoshop modal mutations.
- Writes `codex_autopilot.json`, `codex_baseline.json`, `codex_generated.json`, and activation context files under the IPC folder.

Host automation IPC command surface includes:

- `pingHost`
- `getPsContext`
- `getLayerStack`
- `makeSquareSelection`
- `exportCompositePreview`
- `gotoGroupMask`
- `getMaskState`
- `resetGroupMask`
- `fillGroupMaskRegion`
- `selectionOps`
- `createPolygonSelection`
- `createBezierSelection`
- `exportMaskPreview`
- `getLayerParentGroup`
- `listDocuments`
- `activateDocument`
- `captureCodexBaseline`
- `getCodexBaseline`
- `validateLayerMutation`
- `tagLayerMetadata`
- `safeDeleteGeneratedLayer`
- `safeDeleteGeneratedGroupIfEmpty`
- `checkpoint`
- `rollback`
- `generateCodexActivationContext`
- `getCodexActivationContext`

`tiles/tile-codex.js`

- Visible Codex autopilot authorization tile.
- Stores the profile in `codex.autopilot`.
- Lets the user define the global enabled/paused state, permissions, retouching task categories, task description/notes, model whitelist, allowed sizes, batch limits, square-selection requirements, and safety defaults.
- Pushes the profile to host through `ipcWriteCodexProfile`.
- Hard-off safety boundary: no baseline-layer deletion, no overwrite-save, no flattening.

### 26.4 First-Run Overlays

`tiles/tile-firstrun-welcome.js`

- First-run welcome/feature overview overlay.
- Storage key: `firstrun.welcomeShown`.
- Runs after `app:ready`.
- Emits `firstrun:welcomeClosed` so the satellite recommendation can run after it.
- Exposes `window._firstrunResetWelcome()` for debug/reset flows.

`tiles/tile-firstrun-satellite.js`

- Satellite recommendation overlay.
- Storage key: `firstrun.satelliteShown`.
- Waits for `firstrun:welcomeClosed`, then opens after a short delay.
- "Install now" calls `window._showSatelliteInstallGuide()` if the satellite tile is loaded, else falls back to `installSatellite`.
- "Later" intentionally does not set the shown flag; "never" does.
- Exposes `window._firstrunResetSatellite()` for debug/reset flows.

These files are tile-directory modules but not ordinary registered tile cards.

### 26.5 Browser and Satellite Companion Apps

`tiles/tile-browser.js`

- Browser companion control tile.
- Stores bookmarks in `browser.bookmarks` and idle lock in `browser.idleLock`.
- Calls `checkBrowserStatus`, `installBrowser`, `openBrowserFolder`, and `ipcWriteBrowserConfig`.
- Exposes `window._pushBrowserConfig()` so `core/app.js` can push config during boot.

`tiles/tile-browser.host.js`

- Registers `checkBrowserStatus`, `installBrowser`, `openBrowserFolder`, `ipcWriteBrowserConfig`.
- Reads/writes companion installation/config state and launches the installer path through the host.

`tiles/tile-satellite.js`

- Satellite/remote-control tile.
- Calls `installSatellite`, `checkSatelliteStatus`, `openSatelliteFolder`.
- Shows install guide through `window._showSatelliteInstallGuide()` and hide helper through `window._hideSatelliteInstallGuide()`.
- Listens for `satelliteStatus`, `satelliteInstallStarted`, `satelliteInstallError`, and `ipcCommand`.
- Provides a debug reset path that calls first-run reset globals.

Satellite support outside the tile:

- `host/bootstrap-handlers.js` handles `checkSatelliteStatus`, `installSatellite`, and `openSatelliteFolder`.
- `core/app.js` writes task state to IPC through `ipcWriteState`, syncs thumbnails through `satelliteSyncThumbs`, and exposes `window._pushSatelliteTheme()`.
- `host/low-risk-handlers.js` handles `ipcWriteState`, `ipcReadCommand`, `ipcWriteThemeFile`, and `satelliteSyncThumbs`.
- `host/ipc.js` owns the shared file IPC mechanics.
- `host/satellite-events.js` listens to Photoshop layer deletion/merge/flatten events and emits `psLayerInvalidated` so stale conversation/satellite thumbnails can be marked invalid.

### 26.6 CSS Coverage

Framework styles:

- `styles/base.css`: root variables and global base surface.
- `styles/components.css`: shared component patterns.
- `styles/dock.css`: Dock UI.
- `styles/expand-panels.css`: expanded/inline panel surfaces.
- `styles/groups.css`: topbar/grid/folder/group styling.
- `styles/simple-mode.css`: simplified mode styling.
- `styles/tiles.css`: generic tile card/chrome styling.
- `styles/ui-kit.css`: UIKit dialogs/selects/buttons/controls.

Tile-local CSS:

- Every `tiles/tile-*.css` file is style-only and pairs with the corresponding tile module where present.
- CSS files have no HostAPI action registration; their behavioral ownership lives in the matching `.js` and `.host.js` files.

### 26.7 Factory Config and Scene Data

`factory_layouts/*.json`

- Built-in layout snapshots for Banana standard mode, ComfyUI standard mode, and PsDlink standard mode.
- Consumed by layout workflows, not runtime-mutated.

`factory_scenes/cyberpunk.json`

- Built-in scene pack/config data for the scene tile.
- Pairs with `tiles/tile-scene.js`, `tiles/tile-scene.host.js`, and `_dev/SCENE_TILE_NOTES.md`.

`defaults/*.js` and `defaults/default-layout.json`

- Default layout and migration scripts.
- `layout-migration.js`, `v5-data-migration.js`, `aji-url-migration.js`, and `timeout-migration.js` are boot-time compatibility helpers called from `core/app.js`.

### 26.8 Host Utility Files

`host/concurrency-pool.js`

- Minimal promise queue for bounded parallel work.

`host/recordable-actions.js`

- Integrates Photoshop Action recording/playback.
- Records start-generation, add-to-batch, and capture-reference-image actions.
- Binds global action-step functions for playback into panel/host behavior.

`host/tile-scanner-handlers.js`

- Handles `scanTiles`.
- Scans `tiles/`, applies `tiles/_order.json`, returns JS/CSS file lists through `tilesList`.

`host/tile-host-loader.js`

- Loads every `tiles/*.host.js` module at startup, enabling tile-local `HostAPI.registerAction(...)`.

`_dev/_TEMPLATE.js`, `_dev/_TEMPLATE.host.js`, `_dev/_TEMPLATE.css`

- Development templates only.
- They are included in the code-file inventory because they are source templates, but they are not runtime-loaded unless copied/renamed into live tile paths.
