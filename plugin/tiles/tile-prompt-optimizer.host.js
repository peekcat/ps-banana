// ============================================================
//  tile-prompt-optimizer.host.js
//  提示词优化后端处理器
//
//  原版调用作者部署的代理服务器（无需用户配置 key）。去云化后改成：
//  用用户自己在「AI 助手」磁贴里配置的 OpenAI 兼容接口直连，
//  系统提示词放在 host/aux-prompts.js。
//
//  面板发来的 messages 是用户与模型的多轮对话（不含 system），
//  这里前面补上我们的 system 原样发出去。
//  回包: { success, content, model, error }
// ============================================================

var HostAPI = require('../host/host-api.js');
var auxLlm = require('../host/aux-llm.js');
var auxPrompts = require('../host/aux-prompts.js');

HostAPI.registerAction('promptOptimize', async function(data, ctx) {
    var messages = data && Array.isArray(data.messages) ? data.messages : null;

    function fail(msg) {
        ctx.logToPanel('[提示词优化] 失败: ' + msg, 'error');
        ctx.sendToPanel('promptOptimizeResult', { success: false, content: '', error: msg });
    }

    if (!messages || messages.length === 0) {
        fail('messages 为空');
        return;
    }

    var cfg = auxLlm.readConfig(ctx);
    if (!cfg.ok) {
        fail(cfg.error);
        return;
    }

    ctx.logToPanel('[提示词优化] 调用语言模型... (' + messages.length + ' 条上下文, 模型 ' + cfg.model + ')', 'info');

    try {
        var content = await auxLlm.callChat(cfg, {
            system: auxPrompts.OPTIMIZE_SYSTEM,
            messages: messages,
            temperature: 0.7
        }, ctx);

        var out = auxLlm.stripWrappingQuotes(content);
        if (!out) {
            fail('语言模型返回了空内容');
            return;
        }

        ctx.logToPanel('[提示词优化] 完成 (' + out.length + ' 字, 模型 ' + cfg.model + ')', 'success');
        ctx.sendToPanel('promptOptimizeResult', { success: true, content: out, model: cfg.model });
    } catch (e) {
        fail((e && e.message) || String(e));
    }
}, { tileId: 'prompt-optimizer' });

module.exports = {};
