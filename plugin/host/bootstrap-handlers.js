var serverConfig = require('../core/server-config.js');

async function handleBootstrapAction(action, data, ctx) {
    switch (action) {
        case 'ready':
            console.log('[宿主] WebView 已就绪');
            // 加载早在 host 模块载入时就启动了 (g_storageReady), 这里只 await 它而不重新调一次.
            // 防 bug: 之前 ready 才调 loadHostStorage, panel 可能在它进 await 时插一条 storageSet
            //        给空 _hostStorage 写 key, 然后立即触发关键 key 写盘, 主文件被覆盖成"只剩 1 个 key".
            if (ctx.storageReady) {
                await ctx.storageReady;
            } else if (ctx.loadHostStorage) {
                await ctx.loadHostStorage();
            }
            ctx.sendToPanel('storageLoaded', ctx.hostStorageRef.value);
            // 发送 PS 版本信息
            try {
                var uxpHost = require('uxp').host;
                var psVer = uxpHost.version || '';
                var psName = uxpHost.name || 'Photoshop';
                if (psVer) ctx.sendToPanel('psInfo', { version: psName + ' ' + psVer });
            } catch(vErr) {
                console.warn('[宿主] 读取PS版本失败:', vErr.message);
            }
            ctx.logToPanel('宿主连接成功', 'success');
            return true;

        case 'storageSet':
            // 必须等存储加载完才能动 _hostStorage, 否则会被空对象覆盖
            if (ctx.storageReady) await ctx.storageReady;
            ctx.hostStorageRef.value[data.key] = data.value;
            // 关键 key (API key / 布局 / 主题等) 走立即写盘, 普通 key 走 debounce
            // 见 index.js isCriticalKey 白名单. 防 PS 闪退丢数据 (bug ①)
            if (ctx.saveAfterChange) {
                var r = ctx.saveAfterChange(data.key);
                if (r && typeof r.then === 'function') await r;
            } else {
                ctx.debounceSave();
            }
            return true;

        case 'storageRemove':
            if (ctx.storageReady) await ctx.storageReady;
            delete ctx.hostStorageRef.value[data.key];
            if (ctx.saveAfterChange) {
                var r2 = ctx.saveAfterChange(data.key);
                if (r2 && typeof r2.then === 'function') await r2;
            } else {
                ctx.debounceSave();
            }
            return true;

        case 'storageFlush':
            // 立即把 _hostStorage 同步落盘（取消防抖、await 写入）
            // 用途：location.reload() 之前确保前面的 storageSet 都已持久化
            try {
                if (ctx.storageReady) await ctx.storageReady;
                if (ctx.cancelDebounce) ctx.cancelDebounce();
                if (ctx.saveHostStorage) await ctx.saveHostStorage();
                ctx.sendToPanel('storageFlushDone', { success: true });
            } catch(e) {
                console.warn('[宿主] storageFlush 失败:', e.message);
                ctx.sendToPanel('storageFlushDone', { success: false, error: e.message });
            }
            return true;

        case 'ping':
            ctx.sendToPanel('pong', { message: '宿主连接正常' });
            return true;

        case 'getDocInfo':
            try {
                var psApp = require('photoshop').app;
                var info = { psVersion: ctx.psAppVersion || '' };
                try { info.psVersion = info.psVersion || psApp.version || ''; } catch(_v) {}
                if (psApp.activeDocument) {
                    var doc = psApp.activeDocument;
                    try {
                        var bpc = doc.bitsPerChannel;
                        if (typeof bpc === 'number') info.bitDepth = bpc + '-bit';
                        else if (bpc && bpc._value) {
                            if (bpc._value === 'bitDepth8' || bpc._value === 'eightBits') info.bitDepth = '8-bit';
                            else if (bpc._value === 'bitDepth16' || bpc._value === 'sixteenBits') info.bitDepth = '16-bit';
                            else if (bpc._value === 'bitDepth32' || bpc._value === 'thirtyTwoBits') info.bitDepth = '32-bit';
                            else info.bitDepth = String(bpc._value);
                        } else info.bitDepth = String(bpc);
                    } catch(_b) { info.bitDepth = '读取失败'; }
                    try { info.docName = doc.name || ''; } catch(_n) {}
                    try { info.docWidth = doc.width; info.docHeight = doc.height; } catch(_s) {}
                    try { info.colorMode = String(doc.mode || ''); } catch(_m) {}
                } else {
                    info.bitDepth = '无打开文档';
                }
                ctx.sendToPanel('docInfo', info);
            } catch(diErr) {
                console.error('[宿主] getDocInfo 失败:', diErr.message);
                ctx.sendToPanel('docInfo', { bitDepth: '检测失败', psVersion: ctx.psAppVersion || '' });
            }
            return true;

        case 'downloadUpdate':
            (async function() {
                try {
                    var downloadUrl = data.url;
                    var expectedSha256 = (data.expectedSha256 || '').toLowerCase().trim();
                    if (!downloadUrl) throw new Error('缺少下载地址');
                    ctx.sendToPanel('updateDownloadProgress', { percent: 0, speed: '', downloaded: '', total: '' });

                    // 1. 宿主端直接 fetch zip（流式读取以获取实时进度）。
                    // 下载可较慢，但不能无限挂起；AbortSignal 会连 reader.read 一并取消。
                    var downloadAbort = new AbortController();
                    var downloadTimeoutId = setTimeout(function() {
                        try { downloadAbort.abort(); } catch (_) {}
                    }, 15 * 60 * 1000);
                    var resp = await fetch(downloadUrl, { signal: downloadAbort.signal });
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);

                    var contentLength = parseInt(resp.headers.get('Content-Length') || '0', 10);
                    var totalMB = contentLength > 0 ? (contentLength / 1048576).toFixed(1) : '?';

                    var chunks = [];
                    var received = 0;
                    var startTime = Date.now();
                    var lastReportTime = 0;

                    if (resp.body && typeof resp.body.getReader === 'function') {
                        // 支持流式读取 — 实时进度
                        var reader = resp.body.getReader();
                        while (true) {
                            var result = await reader.read();
                            if (result.done) break;
                            chunks.push(result.value);
                            received += result.value.byteLength;
                            var now = Date.now();
                            if (now - lastReportTime > 300) {
                                lastReportTime = now;
                                var elapsed = (now - startTime) / 1000;
                                var speedMBs = elapsed > 0 ? (received / 1048576 / elapsed).toFixed(1) : '0';
                                var pct = contentLength > 0 ? Math.round((received / contentLength) * 80) : 0;
                                ctx.sendToPanel('updateDownloadProgress', {
                                    percent: Math.min(pct, 80),
                                    speed: speedMBs + ' MB/s',
                                    downloaded: (received / 1048576).toFixed(1) + ' MB',
                                    total: totalMB + ' MB'
                                });
                            }
                        }
                        // 合并 chunks 为 ArrayBuffer
                        var totalLen = 0;
                        for (var ci = 0; ci < chunks.length; ci++) totalLen += chunks[ci].byteLength;
                        var arrayBuf = new ArrayBuffer(totalLen);
                        var u8 = new Uint8Array(arrayBuf);
                        var offset = 0;
                        for (var ci2 = 0; ci2 < chunks.length; ci2++) { u8.set(new Uint8Array(chunks[ci2].buffer || chunks[ci2]), offset); offset += chunks[ci2].byteLength; }
                    } else {
                        // 不支持流式 — 一次性下载
                        ctx.sendToPanel('updateDownloadProgress', { percent: 10, speed: 'downloading...', downloaded: '0', total: totalMB + ' MB' });
                        var arrayBuf = await resp.arrayBuffer();
                        received = arrayBuf.byteLength;
                    }
                    clearTimeout(downloadTimeoutId);
                    downloadTimeoutId = null;

                    var finalElapsed = (Date.now() - startTime) / 1000;
                    var avgSpeed = finalElapsed > 0 ? (received / 1048576 / finalElapsed).toFixed(1) : '?';
                    ctx.sendToPanel('updateDownloadProgress', { percent: 85, speed: avgSpeed + ' MB/s', downloaded: (received / 1048576).toFixed(1) + ' MB', total: (received / 1048576).toFixed(1) + ' MB' });

                    // 1.5 完整性校验: 后端 /api/update/check 给的 sha256 必须和我们下载到的字节匹配
                    //     不匹配 = 中间人换包 / 后端被入侵, 拒绝写盘. 老服务端没下发 sha256 时跳过 (新老兼容)
                    if (expectedSha256) {
                        if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
                            try {
                                var hashBuf = await crypto.subtle.digest('SHA-256', arrayBuf);
                                var hashU8 = new Uint8Array(hashBuf);
                                var hex = '';
                                for (var hi = 0; hi < hashU8.length; hi++) {
                                    var b = hashU8[hi].toString(16);
                                    hex += (b.length === 1 ? '0' : '') + b;
                                }
                                if (hex.toLowerCase() !== expectedSha256) {
                                    throw new Error('更新包完整性校验失败 (sha256 不匹配, 已中止安装, 请重试或联系客服)');
                                }
                                ctx.logToPanel('[更新] 完整性校验通过 (sha256)', 'info');
                            } catch (hashErr) {
                                // digest 本身报错或 hex 不匹配都抛出 (已经把上面那条错误透传过来)
                                throw hashErr;
                            }
                        } else {
                            ctx.logToPanel('[更新] 当前环境不支持 sha256 校验, 已跳过 (建议升级 UXP)', 'warn');
                        }
                    }

                    // 2. 写入 dataFolder
                    var uxpFs = require('uxp').storage.localFileSystem;
                    var dataFolder = await uxpFs.getDataFolder();
                    var zipFile = await dataFolder.createFile('update.zip', { overwrite: true });
                    await zipFile.write(arrayBuf, { format: require('uxp').storage.formats.binary });
                    var zipPath = zipFile.nativePath;
                    ctx.sendToPanel('updateDownloadProgress', { percent: 90, speed: '', downloaded: '', total: '' });

                    // 3. 获取插件目录
                    var pluginFolder = await uxpFs.getPluginFolder();
                    var pluginDir = pluginFolder.nativePath;

                    // 3.5 安全闸门 (host 端最小检查): pluginDir 必须真的是插件目录 (含 manifest.json)
                    //    bat 端也会重复这一检查, 这里只是双保险.
                    //    我们不做路径黑名单 - 那种白名单/黑名单维护成本高, 黑客如果能改 pluginDir 也能绕过黑名单.
                    //    "必须有 manifest.json" 是最强的语义检查: 危险路径 (Adobe 父目录/盘根/Program Files) 都没 manifest.
                    try {
                        await pluginFolder.getEntry('manifest.json');
                    } catch(_mfErr) {
                        throw new Error('插件目录里没有 manifest.json, 拒绝启动更新: ' + pluginDir);
                    }

                    // 4. 生成 JSON 配置文件（UXP 写 UTF-8 正确）
                    //    只放最少的必要字段 - 任何额外字段 (如 createdAt 鲜度检查) 都增加链条断裂风险
                    var cleanZip = zipPath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');
                    var cleanPlugin = pluginDir.replace(/[\/\\]+$/, '').replace(/\//g, '\\');
                    var configJson = JSON.stringify({ zipPath: cleanZip, pluginDir: cleanPlugin });
                    var configFile = await dataFolder.createFile('update_config.json', { overwrite: true });
                    await configFile.write(configJson);

                    // 将插件目录内的静态 bat 复制到 dataFolder
                    //    注意: 不再复制 ps1 - 之前的 launcher+ps1 拆分版本因为 ps1 守门误判导致整条更新链断了.
                    //    现在 bat 是单文件单行 -Command 流程, 跟 6.2.4 一致, 内联 2 道关键守门.
                    try {
                        var srcBat = await pluginFolder.getEntry('update_plugin.bat');
                        var srcContent = await srcBat.read();
                        var dstBat = await dataFolder.createFile('update_plugin.bat', { overwrite: true });
                        await dstBat.write(srcContent);
                    } catch(copyErr) {
                        throw new Error('复制 update_plugin.bat 失败: ' + copyErr.message);
                    }

                    var batPath = dataFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\') + '\\update_plugin.bat';

                    ctx.sendToPanel('updateDownloadProgress', { percent: 100 });
                    ctx.sendToPanel('updateReady', { batPath: batPath, zipPath: cleanZip, pluginDir: cleanPlugin });
                    ctx.logToPanel('[更新] 更新包已下载，脚本已生成: ' + batPath, 'success');

                } catch(e) {
                    try { if (downloadTimeoutId) clearTimeout(downloadTimeoutId); } catch (_) {}
                    console.error('[更新] 失败:', e.message);
                    ctx.sendToPanel('updateError', { error: e && e.name === 'AbortError' ? '更新包下载超时（15 分钟），请检查网络后重试' : e.message });
                }
            })();
            return true;

        case 'launchUpdateBat':
            (async function() {
                try {
                    var shell = require('uxp').shell;
                    if (shell && shell.openPath) await shell.openPath(data.path, 'IMPORTANT: After clicking ALLOW, please CLOSE PHOTOSHOP. Do NOT close the black command window.');
                    else if (shell && shell.openExternal) await shell.openExternal('file:///' + data.path.replace(/\\/g, '/'));
                } catch(e) {
                    ctx.logToPanel('[更新] 无法自动启动 bat: ' + e.message + '，请手动双击桌面上的 bat 文件', 'warn');
                }
            })();
            return true;

        case 'validateAjiKey':
            // 拉服务器 AJI URL 列表 + 跑赛马 (并发查余额, 选最快可用的)
            // 用户填错 URL 的根本性救星: URL 不再让用户填, 全部由服务端下发
            //
            // 容灾: 3 级降级
            //   1. 服务器 /api/aji-urls 拿最新列表  (主路径)
            //   2. 服务器拉不到 → 用 panel 传过来的本地缓存 (data.cachedUrlList)
            //   3. 缓存也没有 → 用代码里硬编码的 FALLBACK_URLS
            // 任一级别有列表就开赛马, 拿到最快可用的 URL
            //
            // 赛马成功时, urlList 会回传给 panel, panel 存到 storage 当下次缓存
            (async function() {
                var FETCH_TIMEOUT = 8000;       // 单个 URL 查余额超时
                var TOTAL_TIMEOUT = 12000;      // 整体赛马超时
                var URL_LIST_TIMEOUT = 5000;    // 拉服务器列表的超时, 单独短一点, 服务器死了就快速降级

                // 硬编码兜底列表 — 服务器和本地缓存都没有时的最后救命稻草
                // 顺序无所谓, 反正赛马会挑最快的
                // 如果未来 URL 换了, 改这里也得发版, 这是最不灵活但最可靠的一层
                var FALLBACK_URLS = [
                    'https://ai.ajiai.top',
                    'https://cn.ajiai.top',
                    'https://ai.ajiapi.top'
                ];

                var key = (data && data.key) || '';
                if (!key || typeof key !== 'string') {
                    ctx.sendToPanel('ajiValidateResult', { success: false, error: 'Key 为空' });
                    return;
                }

                ctx.logToPanel('[AJI 校验] 开始, 拉取服务器 URL 列表...', 'info');

                // 1. 拉服务器 URL 列表
                //    硬超时双保险: AbortController + Promise.race。
                //    万一某环境(如部分 Mac)abort 对卡死连接不生效, Promise.race 也能在
                //    URL_LIST_TIMEOUT 后放行, 绝不让这一步把整个校验冻死。
                var serverUrls = [];
                try {
                    var listAbort = new AbortController();
                    var listTimer = setTimeout(function() { try { listAbort.abort(); } catch(_) {} }, URL_LIST_TIMEOUT);
                    var listFetchP = serverConfig.fetchApi('/api/aji-urls', { method: 'GET', cache: 'no-cache', signal: listAbort.signal })
                        .then(function(resp) {
                            if (!resp.ok) throw new Error('HTTP ' + resp.status);
                            return resp.json();
                        });
                    var listGuardP = new Promise(function(resolve) {
                        setTimeout(function() { resolve({ __timeout: true }); }, URL_LIST_TIMEOUT + 200);
                    });
                    var listJson = await Promise.race([listFetchP, listGuardP]);
                    clearTimeout(listTimer);
                    if (listJson && listJson.__timeout) {
                        ctx.logToPanel('[AJI 校验] 拉服务器 URL 列表超时, 跳过, 直接用缓存+兜底', 'warn');
                    } else if (listJson && Array.isArray(listJson.urls)) {
                        for (var i = 0; i < listJson.urls.length; i++) {
                            if (listJson.urls[i] && typeof listJson.urls[i].url === 'string') {
                                serverUrls.push(listJson.urls[i].url);
                            }
                        }
                    }
                } catch(listErr) {
                    ctx.logToPanel('[AJI 校验] 服务器拉 URL 列表失败: ' + (listErr.message || listErr) + ' — 用缓存+兜底', 'warn');
                }

                // 2. 把 服务器名单 + 本地缓存 + 写死兜底 全部凑成一个候选池, 去重后一起赛马。
                //    ★ 关键修复: 兜底不再是"名单拿不到才用", 而是"永远参赛"。
                //    这样即使服务器给的地址在某些机器(如部分 Mac 网络)上连不上,
                //    那几个公认能用的兜底地址也在赛道里, 照样能赢出来, 不会整体判失败。
                var cachedUrls = (data && Array.isArray(data.cachedUrlList)) ? data.cachedUrlList : [];
                var urls = [];
                var _seen = {};
                [serverUrls, cachedUrls, FALLBACK_URLS].forEach(function(group) {
                    (group || []).forEach(function(u) {
                        if (u && typeof u === 'string' && !_seen[u]) { _seen[u] = 1; urls.push(u); }
                    });
                });

                if (urls.length === 0) {
                    ctx.sendToPanel('ajiValidateResult', { success: false, error: '无任何可用 URL (服务器/缓存/兜底全空), 请联系作者' });
                    ctx.logToPanel('[AJI 校验] 所有来源都没拿到 URL', 'error');
                    return;
                }
                ctx.logToPanel('[AJI 校验] 候选池 ' + urls.length + ' 个 (服务器 ' + serverUrls.length + ' + 缓存 ' + cachedUrls.length + ' + 兜底 ' + FALLBACK_URLS.length + ', 已去重), 开始赛马...', 'info');

                // 4. 赛马: 并发查余额, 第一个返回合法 JSON 的胜出
                //    AJI 余额接口: GET {url}/api/usage/token, 返回 data.data.total_available
                //    (跟 tile-tasks.host.js 的 calibrateBalance 一致, 不重复造)
                function probeOne(baseUrl) {
                    var startTs = Date.now();
                    return new Promise(function(resolve) {
                        var settled = false;
                        var probeAbort = new AbortController();
                        var timer = setTimeout(function() {
                            if (settled) return;
                            settled = true;
                            try { probeAbort.abort(); } catch (_) {}
                            resolve({ url: baseUrl, ok: false, error: 'timeout', latency: FETCH_TIMEOUT });
                        }, FETCH_TIMEOUT);

                        var probeUrl = baseUrl + '/api/usage/token';
                        fetch(probeUrl, {
                            method: 'GET',
                            headers: { 'Authorization': 'Bearer ' + key },
                            cache: 'no-cache',
                            signal: probeAbort.signal
                        }).then(function(r) {
                            if (settled) return;
                            // 401/403 算 Key 错; 200 + 合法 JSON 算 OK; 其他算服务器异常
                            if (r.status === 401 || r.status === 403) {
                                settled = true; clearTimeout(timer);
                                resolve({ url: baseUrl, ok: false, error: 'Key 无效 (HTTP ' + r.status + ')', authFail: true, latency: Date.now() - startTs });
                                return;
                            }
                            if (!r.ok) {
                                settled = true; clearTimeout(timer);
                                resolve({ url: baseUrl, ok: false, error: 'HTTP ' + r.status, latency: Date.now() - startTs });
                                return;
                            }
                            return r.json().then(function(j) {
                                if (settled) return;
                                settled = true; clearTimeout(timer);
                                // 必须能拿到 data.total_available 才算真正的 AJI 接口
                                // (防止某 URL 返回了 200 但内容是别的服务的 JSON)
                                if (!j || !j.data || j.data.total_available === undefined) {
                                    resolve({ url: baseUrl, ok: false, error: '返回不是 AJI 余额格式', latency: Date.now() - startTs });
                                    return;
                                }
                                resolve({
                                    url: baseUrl,
                                    ok: true,
                                    balanceUSD: j.data.total_available / 500000,
                                    latency: Date.now() - startTs
                                });
                            }).catch(function(je) {
                                if (settled) return;
                                settled = true; clearTimeout(timer);
                                resolve({ url: baseUrl, ok: false, error: '解析 JSON 失败: ' + je.message, latency: Date.now() - startTs });
                            });
                        }).catch(function(fe) {
                            if (settled) return;
                            settled = true; clearTimeout(timer);
                            resolve({ url: baseUrl, ok: false, error: fe.message || String(fe), latency: Date.now() - startTs });
                        });
                    });
                }

                // 总超时兜底 (Promise.race 不会取消已发出的 fetch, 但能让我们提前判结果)
                var totalTimer;
                var totalTimeoutP = new Promise(function(resolve) {
                    totalTimer = setTimeout(function() { resolve({ timeout: true }); }, TOTAL_TIMEOUT);
                });

                var allP = Promise.all(urls.map(probeOne));
                var raceResult = await Promise.race([allP, totalTimeoutP]);
                if (totalTimer) clearTimeout(totalTimer);

                var results;
                if (raceResult && raceResult.timeout) {
                    // 总超时 — 等已经完成的 (短暂等一下避免丢结果)
                    ctx.logToPanel('[AJI 校验] 总超时 ' + TOTAL_TIMEOUT + 'ms, 用已完成的部分结果', 'warn');
                    results = await Promise.race([allP, new Promise(function(r) { setTimeout(function() { r([]); }, 500); })]);
                    if (!Array.isArray(results) || results.length === 0) {
                        // 全超时也不挡死 → 降级放行内嵌兜底地址, 让生成去做最终验证
                        ctx.logToPanel('[AJI 校验] 全部超时, 降级放行: 用 ' + FALLBACK_URLS[0], 'warn');
                        ctx.sendToPanel('ajiValidateResult', {
                            success: true,
                            url: FALLBACK_URLS[0],
                            unverified: true,
                            urlSource: 'fallback',
                            info: '校验全部超时, 已用应急地址放行; 若生成报网络错请改用自定义',
                            urlList: null
                        });
                        return;
                    }
                } else {
                    results = raceResult;
                }

                // 3. 找最快的 ok 结果
                var winners = results.filter(function(r) { return r.ok; });
                winners.sort(function(a, b) { return a.latency - b.latency; });

                if (winners.length > 0) {
                    var w = winners[0];
                    var winnerSource = (serverUrls.indexOf(w.url) !== -1) ? 'server'
                                     : (cachedUrls.indexOf(w.url) !== -1 ? 'cache' : 'fallback');
                    ctx.logToPanel('[AJI 校验] ✓ 选中 ' + w.url + ' (' + w.latency + 'ms, 余额 $' + w.balanceUSD.toFixed(4) + '), 候选 ' + winners.length + '/' + urls.length + ' 通过, 中选来源: ' + winnerSource, 'success');
                    ctx.sendToPanel('ajiValidateResult', {
                        success: true,
                        url: w.url,
                        latency: w.latency,
                        balanceUSD: w.balanceUSD,
                        urlSource: winnerSource,
                        // 服务器名单非空就回给 panel 当下次缓存(保持缓存=最新的服务器名单);
                        // 没拿到服务器名单则回 null, 不覆盖已有缓存
                        urlList: (serverUrls.length > 0) ? serverUrls.slice() : null
                    });
                    return;
                }

                // 【设计原则·铁律】校验只是"挑最快地址 + 顺便显示余额"的锦上添花,
                //   绝不能因为校验没过就把用户整个挡死。不管什么原因没通过
                //   (401 / 403 / 超时 / 防火墙拦 / 服务器抽风), 一律降级到插件内嵌的兜底地址放行,
                //   把最终的"鉴权 + 连通"验证交给真正的"生成"去做。
                //   尤其 Mac: 同一个 key 在 Win 能用、Mac 报 401/403, 基本是防火墙按客户端特征(UA/TLS)
                //   拦的 403, 不是 key 真错; 旧代码把 401/403 硬判 Key 无效 → 全部 Mac 用户无法使用。
                results.forEach(function(r) { ctx.logToPanel('[AJI 校验·明细] ' + r.url + ' → ' + (r.error || '?') + ' (' + r.latency + 'ms)', 'info'); });
                var has401 = results.some(function(r) { return /HTTP 401/.test(r.error || ''); });
                var has403 = results.some(function(r) { return /HTTP 403/.test(r.error || ''); });
                var hintMsg;
                if (has403) {
                    hintMsg = '校验被服务器策略拦截(403, 常见于 Mac / 代理网络), 非 Key 问题, 已用应急地址放行';
                } else if (has401) {
                    hintMsg = '校验返回 401, 已用应急地址放行; 若生成报鉴权错请检查 Key 是否填对';
                } else {
                    hintMsg = '未能连到校验接口, 已用应急地址放行; 若生成仍报网络错, 请改用自定义';
                }
                ctx.logToPanel('[AJI 校验] 校验未通过(' + (has403 ? '403策略拦截' : has401 ? '401' : '探测失败') + '), 降级放行: 用 ' + FALLBACK_URLS[0] + ' 让生成去做最终验证', 'warn');
                ctx.sendToPanel('ajiValidateResult', {
                    success: true,
                    url: FALLBACK_URLS[0],
                    unverified: true,
                    urlSource: 'fallback',
                    info: hintMsg,
                    urlList: null
                });
            })();
            return true;

        case 'updateSettings':
            if (data.antiMode !== undefined) ctx.g_antiTruncationModeRef.value = data.antiMode;
            if (data.colorStable !== undefined) ctx.g_colorStableRef.value = !!data.colorStable;
            if (data.layerType !== undefined) ctx.g_layerTypeRef.value = data.layerType;
            if (data.maxResolution !== undefined) ctx.g_maxResolutionRef.value = data.maxResolution;
            if (data.autoGroup !== undefined) ctx.g_autoGroupRef.value = data.autoGroup;
            if (data.autoSelectFullCanvasNoSelection !== undefined) ctx.g_autoSelectFullCanvasNoSelectionRef.value = !!data.autoSelectFullCanvasNoSelection;
            if (data.autoPadCrop !== undefined && ctx.g_autoPadCropRef) ctx.g_autoPadCropRef.value = !!data.autoPadCrop;
            if (data.fix4kMagenta !== undefined && ctx.g_fix4kMagentaRef) ctx.g_fix4kMagentaRef.value = !!data.fix4kMagenta;
            if (data.teachMode !== undefined) ctx.g_teachModeRef.value = !!data.teachMode;
            // returnFeather:同时兼容 v6 的嵌套对象 + v5 的扁平字段(老 panel 调用兜底)
            var rf = (data.returnFeather && typeof data.returnFeather === 'object') ? data.returnFeather : null;
            var rfEnabled    = rf ? rf.enabled        : data.returnFeatherEnabled;
            var rfWorkflows  = rf ? rf.workflows      : data.returnFeatherWorkflows;
            var rfShrinkPct  = rf ? rf.shrinkPercent  : data.returnFeatherShrinkPercent;
            var rfBlurPct    = rf ? rf.blurPercent    : data.returnFeatherBlurPercent;
            if (rfEnabled !== undefined && ctx.g_returnFeatherEnabledRef) ctx.g_returnFeatherEnabledRef.value = !!rfEnabled;
            if (rfWorkflows !== undefined && ctx.g_returnFeatherWorkflowsRef) ctx.g_returnFeatherWorkflowsRef.value = rfWorkflows || {};
            if (rfShrinkPct !== undefined && ctx.g_returnFeatherShrinkPercentRef) ctx.g_returnFeatherShrinkPercentRef.value = rfShrinkPct;
            if (rfBlurPct !== undefined && ctx.g_returnFeatherBlurPercentRef) ctx.g_returnFeatherBlurPercentRef.value = rfBlurPct;
            return true;

        // ============================================================
        //  卫星插件: checkSatelliteStatus
        //  检查 PS Plug-ins\轮椅遥控器\manifest.json 是否存在 + 读版本
        //  返回: { installed, installedVersion?, latestVersion, targetDir }
        // ============================================================
        case 'checkSatelliteStatus':
            (async function() {
                try {
                    var uxpFs = require('uxp').storage.localFileSystem;
                    var pluginFolder = await uxpFs.getPluginFolder();
                    // 1. 读主插件源码内置的卫星 zip 内 meta (实际从 satellite/manifest.json 读源)
                    //    但 zip 在 plugin 根目录, 我们直接读 satellite/manifest.json (开发时) 或者从 zip 读
                    //    简化: 内置版本号写死在主插件这边的常量
                    var latestVersion = '2.0.0';   // 跟 satellite/manifest.json version 同步
                    // 2. 推算 PS Plug-ins 路径: pluginFolder.nativePath 上一级
                    //    主插件装在 ...\Plug-ins\<plugin-name>\, 父目录就是 Plug-ins
                    var pluginPath = pluginFolder.nativePath || '';
                    // 转 windows 路径 + 去末斜杠
                    pluginPath = pluginPath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');
                    var idx = pluginPath.lastIndexOf('\\');
                    var pluginsDir = idx > 0 ? pluginPath.substring(0, idx) : pluginPath;
                    var satelliteDir = pluginsDir + '\\轮椅遥控器';

                    // 3. 读卫星已装版本 (用 file url 跨目录读)
                    var installed = false;
                    var installedVersion = null;
                    try {
                        var url = 'file:' + satelliteDir.replace(/\\/g, '/') + '/manifest.json';
                        var entry = await uxpFs.getEntryWithUrl(url);
                        var text = await entry.read();
                        var mf = JSON.parse(text);
                        installed = true;
                        installedVersion = mf.version || '?';
                    } catch (e) { /* 没装 */ }

                    ctx.sendToPanel('satelliteStatus', {
                        installed: installed,
                        installedVersion: installedVersion,
                        latestVersion: latestVersion,
                        targetDir: satelliteDir,
                        pluginsDir: pluginsDir
                    });
                } catch (e) {
                    ctx.sendToPanel('satelliteStatus', { installed: false, error: e.message });
                }
            })();
            return true;

        // ============================================================
        //  卫星插件: installSatellite
        //  释放内置 satellite-pkg.zip + bat 到 dataFolder, 调起 bat 提权安装
        //  bat 流程: 等 PS 关 → 提权解压到 PS Plug-ins\轮椅遥控器\
        // ============================================================
        case 'installSatellite':
            (async function() {
                try {
                    var uxpFs = require('uxp').storage.localFileSystem;
                    var formats = require('uxp').storage.formats;
                    var pluginFolder = await uxpFs.getPluginFolder();
                    var dataFolder = await uxpFs.getDataFolder();

                    // 1. 拷贝内置 satellite-pkg.zip 到 dataFolder (跨目录读不支持直接拷, 需要 read+write)
                    var srcZip = await pluginFolder.getEntry('satellite-pkg.zip');
                    var srcBuf = await srcZip.read({ format: formats.binary });
                    var dstZip = await dataFolder.createFile('satellite-pkg.zip', { overwrite: true });
                    await dstZip.write(srcBuf, { format: formats.binary });
                    var zipPath = dstZip.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');

                    // 2. 推算目标安装目录 (PS Plug-ins\轮椅遥控器\)
                    var pluginPath = pluginFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');
                    var idx = pluginPath.lastIndexOf('\\');
                    var pluginsDir = idx > 0 ? pluginPath.substring(0, idx) : pluginPath;
                    var targetDir = pluginsDir + '\\轮椅遥控器';

                    // 3. 写 satellite_install_config.json
                    var configJson = JSON.stringify({ zipPath: zipPath, targetDir: targetDir });
                    var configFile = await dataFolder.createFile('satellite_install_config.json', { overwrite: true });
                    await configFile.write(configJson);

                    // 4. 拷贝 install_satellite.bat 到 dataFolder (插件目录可能只读)
                    var srcBat = await pluginFolder.getEntry('install_satellite.bat');
                    var srcBatContent = await srcBat.read();
                    var dstBat = await dataFolder.createFile('install_satellite.bat', { overwrite: true });
                    await dstBat.write(srcBatContent);
                    var batPath = dataFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\') + '\\install_satellite.bat';

                    // 5. 调起 bat
                    var shell = require('uxp').shell;
                    if (shell && shell.openPath) {
                        await shell.openPath(batPath, '即将安装/升级卫星插件 \"轮椅遥控器\"。点击允许后, 请先关闭 Photoshop。');
                    } else if (shell && shell.openExternal) {
                        await shell.openExternal('file:///' + batPath.replace(/\\/g, '/'));
                    }

                    ctx.sendToPanel('satelliteInstallStarted', { batPath: batPath, targetDir: targetDir });
                    ctx.logToPanel('[卫星] 安装脚本已启动: ' + batPath, 'success');
                } catch (e) {
                    ctx.sendToPanel('satelliteInstallError', { error: e.message });
                    ctx.logToPanel('[卫星] 安装失败: ' + e.message, 'error');
                }
            })();
            return true;

        // ============================================================
        //  卫星插件: openSatelliteFolder
        //  打开 PS Plug-ins\轮椅遥控器\ 目录, 让用户检查/手动卸载
        // ============================================================
        case 'openSatelliteFolder':
            (async function() {
                try {
                    var uxpFs = require('uxp').storage.localFileSystem;
                    var pluginFolder = await uxpFs.getPluginFolder();
                    var pluginPath = pluginFolder.nativePath.replace(/[\/\\]+$/, '').replace(/\//g, '\\');
                    var idx = pluginPath.lastIndexOf('\\');
                    var pluginsDir = idx > 0 ? pluginPath.substring(0, idx) : pluginPath;
                    var targetDir = pluginsDir + '\\轮椅遥控器';
                    var shell = require('uxp').shell;
                    if (shell && shell.openPath) {
                        await shell.openPath(targetDir);
                    }
                } catch (e) {
                    ctx.logToPanel('[卫星] 打开目录失败: ' + e.message, 'warn');
                }
            })();
            return true;
    }

    return false;
}

module.exports = {
    handleBootstrapAction: handleBootstrapAction
};
