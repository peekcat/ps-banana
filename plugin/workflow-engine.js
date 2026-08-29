/**
 * workflow-engine.js - 工作流转换与执行引擎
 * 
 * 核心功能:
 * 1. 获取 ComfyUI object_info (节点 widget 定义)
 * 2. 解析 LiteGraph 工作流，提取可编辑 widget
 * 3. LiteGraph → API Prompt 格式转换
 * 4. 提交执行 + 轮询结果
 * 5. 获取输出图像
 */

// ======================================================================
//  object_info 缓存
// ======================================================================
let _objectInfoCache = null;

/**
 * 清除 object_info 缓存（切换 ComfyUI 服务器时调用）
 */
function clearObjectInfoCache() {
    _objectInfoCache = null;
}

/**
 * 获取全量 object_info（节点类型定义）
 */
async function fetchObjectInfo(baseURL) {
    if (_objectInfoCache) return _objectInfoCache;
    
    const resp = await fetch(`${baseURL}/object_info`);
    if (!resp.ok) throw new Error(`获取 object_info 失败: HTTP ${resp.status}`);
    _objectInfoCache = await resp.json();
    return _objectInfoCache;
}

/**
 * 获取指定节点类型的 object_info
 */
function getNodeTypeInfo(classType) {
    if (!_objectInfoCache || !_objectInfoCache[classType]) return null;
    return _objectInfoCache[classType];
}

// ======================================================================
//  Widget 类型判断工具
// ======================================================================

// seed 控制模式值（ComfyUI 前端注入的隐藏 widget，不在 object_info 中）
const SEED_CONTROL_VALUES = new Set(['fixed', 'randomize', 'increment', 'decrement']);

/**
 * 判断是否是 seed 类型的 INT（max 值极大）
 */
function isSeedLikeInt(inputName, inputDef) {
    if (!Array.isArray(inputDef) || inputDef.length < 2) return false;
    const type = inputDef[0];
    if (typeof type !== 'string' || type.toUpperCase() !== 'INT') return false;
    const config = inputDef[1] || {};
    // seed/noise_seed 名称匹配，或 max 值 > 2^48
    return inputName.toLowerCase().includes('seed') || (config.max && config.max > 281474976710656);
}

/**
 * 判断 object_info 中的 input 定义是什么类型的 widget
 * 返回: { widgetType, config }
 *   widgetType: 'INT' | 'FLOAT' | 'STRING' | 'COMBO' | 'BOOL' | 'CONNECTED' (连接输入,非widget)
 */
function classifyInput(inputDef) {
    if (!Array.isArray(inputDef) || inputDef.length === 0) {
        return { widgetType: 'CONNECTED', config: {} };
    }

    const firstElement = inputDef[0];
    
    // Combo/dropdown: [["option1", "option2", ...]]
    if (Array.isArray(firstElement)) {
        return { widgetType: 'COMBO', config: { options: firstElement } };
    }
    
    // 类型字符串
    if (typeof firstElement === 'string') {
        const typeStr = firstElement.toUpperCase();
        const config = inputDef.length > 1 ? inputDef[1] : {};
        
        switch (typeStr) {
            case 'INT':
                return { widgetType: 'INT', config: {
                    default: config.default ?? 0,
                    min: config.min ?? 0,
                    max: config.max ?? 99999999,
                    step: config.step ?? 1,
                }};
            case 'FLOAT':
                return { widgetType: 'FLOAT', config: {
                    default: config.default ?? 0.0,
                    min: config.min ?? 0.0,
                    max: config.max ?? 100.0,
                    step: config.step ?? 0.01,
                    round: config.round ?? 0.001,
                }};
            case 'STRING':
                return { widgetType: 'STRING', config: {
                    default: config.default ?? '',
                    multiline: config.multiline ?? false,
                    placeholder: config.placeholder ?? '',
                }};
            case 'BOOLEAN':
                return { widgetType: 'BOOL', config: {
                    default: config.default ?? false,
                }};
            default:
                // MODEL, CONDITIONING, LATENT, IMAGE 等 → 连接输入
                return { widgetType: 'CONNECTED', config: {}, typeName: typeStr };
        }
    }
    
    return { widgetType: 'CONNECTED', config: {} };
}

// ======================================================================
//  工作流解析：提取可编辑 widgets
// ======================================================================

/**
 * 从 LiteGraph 工作流解析出每个节点的可编辑 widgets
 * 
 * @param {Object} workflow - LiteGraph 格式工作流 { nodes, links, ... }
 * @param {Object} objectInfo - ComfyUI object_info
 * @returns {Array} 节点数组，每个节点包含 { nodeId, title, type, widgets[] }
 *   widget: { name, widgetType, config, value, inputIndex }
 */
function parseWorkflowWidgets(workflow, objectInfo) {
    if (!workflow.nodes) return [];
    
    const result = [];
    
    // 构建 link 映射：link_id → { sourceNodeId, sourceSlot }
    const linkMap = {};
    if (workflow.links) {
        workflow.links.forEach(link => {
            // link 格式: [link_id, source_node_id, source_slot, target_node_id, target_slot, type]
            linkMap[link[0]] = {
                sourceNodeId: link[1],
                sourceSlot: link[2],
                targetNodeId: link[3],
                targetSlot: link[4],
                type: link[5],
            };
        });
    }
    
    workflow.nodes.forEach(node => {
        const classType = node.type;
        const nodeInfo = objectInfo[classType];
        
        if (!nodeInfo || !nodeInfo.input) {
            // 未知节点类型：使用 fallback 从 widgets_values + node.widgets 提取
            const fallbackEntry = {
                nodeId: node.id,
                title: node.title || classType,
                type: classType,
                widgets: [],
                connectedInputs: {},
                _isUnknown: true,
            };
            const connectedNames = new Set();
            if (node.inputs) {
                node.inputs.forEach(inp => {
                    if (inp.link !== null && inp.link !== undefined) {
                        connectedNames.add(inp.name);
                    }
                });
            }
            // 尝试从 LiteGraph node.widgets 元数据提取
            if (node.widgets_values) {
                if (node.widgets && node.widgets.length > 0) {
                    node.widgets.forEach((w, idx) => {
                        if (!w || !w.name) return;
                        const val = idx < node.widgets_values.length ? node.widgets_values[idx] : undefined;
                        const isConn = connectedNames.has(w.name);
                        // 推断 widgetType
                        let wType = 'STRING';
                        if (typeof val === 'number') wType = Number.isInteger(val) ? 'INT' : 'FLOAT';
                        else if (typeof val === 'boolean') wType = 'BOOL';
                        else if (w.type === 'combo' || (w.options && w.options.values)) wType = 'COMBO';
                        fallbackEntry.widgets.push({
                            name: w.name,
                            widgetType: wType,
                            config: wType === 'COMBO' ? { options: (w.options && w.options.values) || [] } : {},
                            value: val,
                            isConnected: isConn,
                        });
                    });
                } else {
                    // 没有 node.widgets 元数据，用索引作为名称
                    node.widgets_values.forEach((val, idx) => {
                        if (val === undefined || val === null) return;
                        let wType = 'STRING';
                        if (typeof val === 'number') wType = Number.isInteger(val) ? 'INT' : 'FLOAT';
                        else if (typeof val === 'boolean') wType = 'BOOL';
                        fallbackEntry.widgets.push({
                            name: 'param_' + idx,
                            widgetType: wType,
                            config: {},
                            value: val,
                            isConnected: false,
                        });
                    });
                }
            }
            if (fallbackEntry.widgets.length > 0) {
                result.push(fallbackEntry);
            }
            return;
        }
        
        const nodeEntry = {
            nodeId: node.id,
            title: node.title || classType,
            type: classType,
            widgets: [],
            // 保存连接信息
            connectedInputs: {},
        };
        
        // 获取已连接的输入名称集合
        // node.inputs[] 中有 link 值的表示已连接
        const connectedInputNames = new Set();
        if (node.inputs) {
            node.inputs.forEach(inp => {
                if (inp.link !== null && inp.link !== undefined) {
                    connectedInputNames.add(inp.name);
                    nodeEntry.connectedInputs[inp.name] = linkMap[inp.link] || null;
                }
            });
        }
        
        // 按 required → optional 顺序遍历 inputs
        // widgets_values 数组的顺序对应非连接 widget 的定义顺序
        let widgetValueIndex = 0;
        const widgetValues = node.widgets_values || [];
        
        const allInputs = {};
        if (nodeInfo.input.required) Object.assign(allInputs, nodeInfo.input.required);
        if (nodeInfo.input.optional) Object.assign(allInputs, nodeInfo.input.optional);
        
        // 遍历 object_info 中定义的输入
        for (const [inputName, inputDef] of Object.entries(allInputs)) {
            const { widgetType, config, typeName } = classifyInput(inputDef);
            
            if (widgetType === 'CONNECTED') {
                // 这是连接类型（MODEL, IMAGE 等），不是 widget
                // 但如果它也出现在 widgets_values 中（某些节点同时支持连接和widget），
                // 这种情况在 ComfyUI 中存在但罕见
                continue;
            }
            
            // 如果这个输入已经有连接，它在 widgets_values 中可能仍然有一个占位值
            // ComfyUI LiteGraph 在连接时通常会跳过 widget value，但有时会保留
            // 我们需要正确追踪 widgetValueIndex
            
            const isConnected = connectedInputNames.has(inputName);
            
            // 获取当前 widget 的值
            let currentValue = config.default;
            if (widgetValueIndex < widgetValues.length) {
                currentValue = widgetValues[widgetValueIndex];
            }
            widgetValueIndex++;
            
            // 跳过 seed 后的 control_after_generate 隐藏 widget
            if (isSeedLikeInt(inputName, inputDef) && 
                widgetValueIndex < widgetValues.length && 
                typeof widgetValues[widgetValueIndex] === 'string' &&
                SEED_CONTROL_VALUES.has(widgetValues[widgetValueIndex])) {
                widgetValueIndex++;
            }
            
            // 已连接的输入不显示为可编辑 widget（但保留在数据中）
            nodeEntry.widgets.push({
                name: inputName,
                widgetType: widgetType,
                config: config,
                value: currentValue,
                isConnected: isConnected,
            });
        }
        
        // 添加所有有 widget 的节点（包括已连接的，前端显示为只读）
        if (nodeEntry.widgets.length > 0) {
            result.push(nodeEntry);
        }
    });
    
    return result;
}

// ======================================================================
//  LiteGraph → API Prompt 转换
// ======================================================================

/**
 * 将 LiteGraph 工作流 + 用户编辑的参数 转换为 ComfyUI API Prompt 格式
 * 
 * @param {Object} workflow - LiteGraph 工作流
 * @param {Object} objectInfo - ComfyUI object_info
 * @param {Object} editedValues - 用户编辑的值 { "nodeId.widgetName": value }
 * @returns {Object} API prompt { "nodeId": { class_type, inputs: {...} } }
 */
// 前端专用虚拟节点类型（不应出现在 API prompt 中）
const FRONTEND_ONLY_NODES = new Set(['PrimitiveNode', 'Reroute', 'Note']);

function convertToAPIPrompt(workflow, objectInfo, editedValues = {}) {
    if (!workflow.nodes) throw new Error('工作流格式不正确');
    
    const prompt = {};
    
    // 构建 link 映射
    const linkMap = {};
    if (workflow.links) {
        workflow.links.forEach(link => {
            linkMap[link[0]] = {
                sourceNodeId: link[1],
                sourceSlot: link[2],
            };
        });
    }
    
    // 构建节点 ID → 节点对象映射
    const nodeById = {};
    workflow.nodes.forEach(n => { nodeById[n.id] = n; });
    
    /**
     * 解析 PrimitiveNode/Reroute 的实际值
     * PrimitiveNode: 优先使用 editedValues，否则返回 widgets_values[0]（常量值）
     * Reroute: 追溯上游连接，直到找到非 Reroute 节点
     */
    function resolvePrimitiveValue(nodeId) {
        const node = nodeById[nodeId];
        if (!node) return undefined;
        
        if (node.type === 'PrimitiveNode') {
            const nid = String(nodeId);
            const origVal = node.widgets_values && node.widgets_values.length > 0 ? node.widgets_values[0] : undefined;
            
            // 检查 editedValues：PrimitiveNode 在 fallback 解析中可能使用 param_0 或实际 widget 名
            // 尝试所有可能的 key
            let editedVal = undefined;
            let found = false;
            
            // 1. 尝试 param_0（fallback 解析时无 node.widgets 元数据的情况）
            if (editedValues.hasOwnProperty(nid + '.param_0')) {
                editedVal = editedValues[nid + '.param_0'];
                found = true;
            }
            // 2. 尝试实际 widget 名（有 node.widgets 元数据的情况）
            if (!found && node.widgets && node.widgets[0] && node.widgets[0].name) {
                const wName = node.widgets[0].name;
                if (editedValues.hasOwnProperty(nid + '.' + wName)) {
                    editedVal = editedValues[nid + '.' + wName];
                    found = true;
                }
            }
            // 3. 通用搜索：找到第一个匹配 nodeId.* 的 key（排除 control_after_generate）
            if (!found) {
                for (const key of Object.keys(editedValues)) {
                    if (key.startsWith(nid + '.') && !key.endsWith('.param_1')) {
                        editedVal = editedValues[key];
                        found = true;
                        break;
                    }
                }
            }
            
            if (found && editedVal !== undefined) {
                // 类型转换：根据原始值类型推断
                if (typeof origVal === 'number') {
                    if (Number.isInteger(origVal)) {
                        editedVal = parseInt(editedVal);
                        if (isNaN(editedVal)) editedVal = origVal;
                    } else {
                        editedVal = parseFloat(editedVal);
                        if (isNaN(editedVal)) editedVal = origVal;
                    }
                } else if (typeof origVal === 'boolean') {
                    editedVal = (editedVal === 'true' || editedVal === true);
                }
                return editedVal;
            }
            
            return origVal;
        }
        
        if (node.type === 'Reroute') {
            // Reroute 追溯上游
            if (node.inputs && node.inputs[0] && node.inputs[0].link != null) {
                const upstreamLink = linkMap[node.inputs[0].link];
                if (upstreamLink) {
                    const upNode = nodeById[upstreamLink.sourceNodeId];
                    if (upNode && FRONTEND_ONLY_NODES.has(upNode.type)) {
                        return resolvePrimitiveValue(upstreamLink.sourceNodeId);
                    }
                    // 非虚拟节点 → 返回连接引用
                    return [String(upstreamLink.sourceNodeId), upstreamLink.sourceSlot];
                }
            }
            return undefined;
        }
        
        return undefined; // 不是虚拟节点
    }
    
    /**
     * 解析连接引用：如果连接的源节点是虚拟节点，内联其值
     */
    function resolveConnection(sourceNodeId, sourceSlot) {
        const sourceNode = nodeById[sourceNodeId];
        if (!sourceNode) return [String(sourceNodeId), sourceSlot];
        
        if (sourceNode.type === 'PrimitiveNode') {
            return resolvePrimitiveValue(sourceNodeId);
        }
        
        if (sourceNode.type === 'Reroute') {
            const resolved = resolvePrimitiveValue(sourceNodeId);
            if (resolved !== undefined) return resolved;
        }
        
        // 普通节点 → 保持连接引用
        return [String(sourceNodeId), sourceSlot];
    }
    
    const _skippedNodes = [];
    
    workflow.nodes.forEach(node => {
        // 跳过前端专用虚拟节点
        if (FRONTEND_ONLY_NODES.has(node.type)) {
            return;
        }
        
        const classType = node.type;
        const nodeInfo = objectInfo[classType];
        const nodeId = String(node.id);
        const inputs = {};
        
        // 构建连接输入（无论是否有 object_info 都需要）
        
        // 获取已连接的输入（解析虚拟节点引用）
        const connectedInputs = {};
        if (node.inputs) {
            node.inputs.forEach((inp, slotIndex) => {
                if (inp.link !== null && inp.link !== undefined) {
                    const linkInfo = linkMap[inp.link];
                    if (linkInfo) {
                        // 解析 PrimitiveNode/Reroute → 内联值
                        connectedInputs[inp.name] = resolveConnection(linkInfo.sourceNodeId, linkInfo.sourceSlot);
                    }
                }
            });
        }
        
        // 未知节点类型：使用 fallback（连接 + 原始 widget 值）
        if (!nodeInfo || !nodeInfo.input) {
            // 添加所有连接（已解析虚拟节点）
            Object.assign(inputs, connectedInputs);
            
            // 尝试从 node.widgets 和 widgets_values 提取原始值
            if (node.widgets_values && node.widgets) {
                node.widgets.forEach((w, idx) => {
                    if (w && w.name && !Object.prototype.hasOwnProperty.call(connectedInputs, w.name)) {
                        const val = idx < node.widgets_values.length ? node.widgets_values[idx] : undefined;
                        if (val !== undefined) inputs[w.name] = val;
                    }
                });
            }
            
            _skippedNodes.push(`[${nodeId}] ${classType} (未知节点，使用 fallback)`);
            prompt[nodeId] = { class_type: classType, inputs: inputs };
            return; // 继续下一个节点
        }
        
        // 遍历 object_info 的输入定义
        const allInputDefs = {};
        if (nodeInfo.input.required) Object.assign(allInputDefs, nodeInfo.input.required);
        if (nodeInfo.input.optional) Object.assign(allInputDefs, nodeInfo.input.optional);
        
        let widgetValueIndex = 0;
        const widgetValues = node.widgets_values || [];
        
        for (const [inputName, inputDef] of Object.entries(allInputDefs)) {
            const { widgetType } = classifyInput(inputDef);
            
            if (widgetType === 'CONNECTED') {
                // 类型是 MODEL/IMAGE 等 → 不是 widget，不占 widgets_values 位置
                // 如果有连接，设置连接引用
                if (Object.prototype.hasOwnProperty.call(connectedInputs, inputName)) {
                    inputs[inputName] = connectedInputs[inputName];
                }
                continue;
            }
            
            // 以下是 widget 类型（INT/FLOAT/STRING/COMBO/BOOL）
            // 即使被连接，也要消耗 widgetValueIndex（LiteGraph 中仍保留值）
            
            // 如果有连接，使用连接引用，但仍然递增 index
            if (Object.prototype.hasOwnProperty.call(connectedInputs, inputName)) {
                inputs[inputName] = connectedInputs[inputName];
                widgetValueIndex++;
                continue;
            }
            
            // Widget 输入：优先使用用户编辑的值
            const editKey = `${nodeId}.${inputName}`;
            let value;
            
            if (editedValues.hasOwnProperty(editKey)) {
                value = editedValues[editKey];
                // 类型转换
                if (widgetType === 'INT') value = parseInt(value) || 0;
                else if (widgetType === 'FLOAT') value = parseFloat(value) || 0.0;
                else if (widgetType === 'BOOL') {
                    value = (typeof value === 'string')
                        ? value.trim().toLowerCase() === 'true'
                        : !!value;
                }
            } else {
                // 使用工作流中的原始值
                value = widgetValueIndex < widgetValues.length ? widgetValues[widgetValueIndex] : undefined;
            }
            
            if (value !== undefined) {
                inputs[inputName] = value;
            }
            
            widgetValueIndex++;
            
            // 跳过 seed 后的 control_after_generate 隐藏 widget
            // ComfyUI 前端在 seed 类型 INT 后自动注入 "fixed"/"randomize"/"increment"/"decrement"
            if (isSeedLikeInt(inputName, inputDef) && 
                widgetValueIndex < widgetValues.length && 
                typeof widgetValues[widgetValueIndex] === 'string' &&
                SEED_CONTROL_VALUES.has(widgetValues[widgetValueIndex])) {
                widgetValueIndex++; // 跳过 control_after_generate
            }
        }
        
        prompt[nodeId] = {
            class_type: classType,
            inputs: inputs,
        };
    });
    
    return prompt;
}

// ======================================================================
//  执行工作流
// ======================================================================

/**
 * 提交工作流到 ComfyUI 执行
 * @returns {string} prompt_id
 */
async function submitPrompt(baseURL, prompt) {
    const resp = await fetch(`${baseURL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt }),
    });
    
    if (!resp.ok) {
        const text = await resp.text();
        // 解析节点错误详情
        try {
            const errData = JSON.parse(text);
            if (errData.node_errors) {
                const errNodes = Object.entries(errData.node_errors).map(([id, info]) => {
                    const msgs = (info.errors || []).map(e => e.message + ': ' + e.details).join('; ');
                    return `[${id}] ${info.class_type}: ${msgs}`;
                });
                throw new Error(`节点验证失败:\n${errNodes.join('\n')}`);
            }
        } catch (parseErr) {
            if (parseErr.message.includes('节点验证失败')) throw parseErr;
        }
        throw new Error(`提交失败 HTTP ${resp.status}: ${text}`);
    }
    
    const result = await resp.json();
    // 检查是否有节点警告
    if (result.node_errors && Object.keys(result.node_errors).length > 0) {
        const warnNodes = Object.keys(result.node_errors);
        console.warn(`[PS Bridge] 部分节点有警告: ${warnNodes.join(', ')}`);
    }
    return result.prompt_id;
}

/**
 * 轮询检查任务是否完成
 * @returns {Object} history entry for the prompt
 */
async function pollForCompletion(baseURL, promptId, onProgress, timeoutMs = 3600000) {
    const startTime = Date.now();
    const pollInterval = 1000;
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const resp = await fetch(`${baseURL}/history/${promptId}`);
            if (resp.ok) {
                const history = await resp.json();
                if (history[promptId]) {
                    const entry = history[promptId];
                    if (entry.status && entry.status.completed) {
                        return entry;
                    }
                    if (entry.status && entry.status.status_str === 'error') {
                        throw new Error('ComfyUI 执行出错: ' + JSON.stringify(entry.status));
                    }
                }
            }
        } catch (e) {
            if (e.message.includes('执行出错')) throw e;
            // 其他错误（网络问题）继续重试
        }
        
        if (onProgress) {
            const elapsed = (Date.now() - startTime) / 1000;
            onProgress(`执行中... ${elapsed.toFixed(0)}s`);
        }
        
        // 等待
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    
    throw new Error(`执行超时 (${timeoutMs/1000}s)`);
}

/**
 * 从 history 中提取输出图像信息
 * @returns {Array} [{ filename, subfolder, type }]
 */
function extractOutputImages(historyEntry) {
    const images = [];
    if (!historyEntry.outputs) return images;
    
    for (const [nodeId, output] of Object.entries(historyEntry.outputs)) {
        if (output.images) {
            output.images.forEach(img => {
                images.push({
                    filename: img.filename,
                    subfolder: img.subfolder || '',
                    type: img.type || 'output',
                    nodeId: nodeId,
                });
            });
        }
    }
    
    return images;
}

/**
 * 下载图像数据
 * @returns {ArrayBuffer} 图像二进制数据
 */
async function downloadImage(baseURL, imageInfo) {
    const params = new URLSearchParams({
        filename: imageInfo.filename,
        subfolder: imageInfo.subfolder,
        type: imageInfo.type,
    });
    
    const resp = await fetch(`${baseURL}/view?${params}`);
    if (!resp.ok) throw new Error(`下载图像失败: HTTP ${resp.status}`);
    
    return await resp.arrayBuffer();
}

/**
 * 上传图像到 ComfyUI
 * @returns {Object} { name, subfolder, type }
 */
async function uploadImage(baseURL, pngArrayBuffer, filename) {
    const formData = new FormData();
    const blob = new Blob([pngArrayBuffer], { type: 'image/png' });
    formData.append('image', blob, filename || 'ps_canvas.png');
    formData.append('overwrite', 'true');
    
    const resp = await fetch(`${baseURL}/upload/image`, {
        method: 'POST',
        body: formData,
    });
    
    if (!resp.ok) throw new Error(`上传图像失败: HTTP ${resp.status}`);
    
    return await resp.json();
}

// ======================================================================
//  导出
// ======================================================================
module.exports = {
    fetchObjectInfo,
    clearObjectInfoCache,
    getNodeTypeInfo,
    classifyInput,
    parseWorkflowWidgets,
    convertToAPIPrompt,
    submitPrompt,
    pollForCompletion,
    extractOutputImages,
    downloadImage,
    uploadImage,
};
