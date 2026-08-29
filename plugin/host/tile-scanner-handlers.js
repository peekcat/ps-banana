// ============================================================
//  tile-scanner-handlers.js
//  扫描 tiles/ 目录，告诉前端有哪些磁贴模块需要加载。
//  支持可选的 tiles/_order.json 指定默认加载顺序。
// ============================================================

async function handleTileScannerAction(action, data, ctx) {
    if (action !== 'scanTiles') return false;

    try {
        const fs = ctx.uxpModule.storage.localFileSystem;
        const pluginFolder = await fs.getPluginFolder();
        const tilesFolder = await pluginFolder.getEntry('tiles');
        const entries = await tilesFolder.getEntries();

        const jsFiles = [];
        const cssFiles = [];
        let orderList = null;

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry.isFile) continue;
            const name = entry.name;

            if (name === '_order.json') {
                try {
                    const text = await entry.read();
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed)) orderList = parsed;
                    else if (parsed && Array.isArray(parsed.order)) orderList = parsed.order;
                } catch (parseErr) {
                    console.warn('[tile-scanner] _order.json 解析失败:', parseErr.message);
                }
            } else if (/^tile-.+\.js$/i.test(name) && !/\.host\.js$/i.test(name)) {
                jsFiles.push(name);
            } else if (/^tile-.+\.css$/i.test(name)) {
                cssFiles.push(name);
            }
        }

        // 应用默认顺序：_order.json 里的先来，剩下的按字母序追加到末尾
        let orderedJs;
        if (orderList) {
            orderedJs = [];
            const remaining = jsFiles.slice();
            for (let j = 0; j < orderList.length; j++) {
                const want = orderList[j];
                const idx = remaining.indexOf(want);
                if (idx >= 0) {
                    orderedJs.push(want);
                    remaining.splice(idx, 1);
                }
            }
            remaining.sort();
            orderedJs = orderedJs.concat(remaining);
        } else {
            orderedJs = jsFiles.slice().sort();
        }

        cssFiles.sort();

        console.log('[tile-scanner] 扫描到磁贴: ' + orderedJs.length + ' 个 JS, ' + cssFiles.length + ' 个 CSS');
        ctx.sendToPanel('tilesList', { jsFiles: orderedJs, cssFiles: cssFiles });
    } catch (err) {
        console.error('[tile-scanner] 扫描失败:', err && err.message);
        ctx.sendToPanel('tilesList', { jsFiles: [], cssFiles: [], error: (err && err.message) || String(err) });
    }

    return true;
}

module.exports = { handleTileScannerAction: handleTileScannerAction };
