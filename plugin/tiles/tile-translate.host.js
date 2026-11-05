// ============================================================
//  tile-translate.host.js
//  翻译后端处理器
//
//  原版把请求转给作者服务器（有道密钥在服务端）。去云化后改成：
//  用用户自己在「AI 助手」磁贴里配置的 OpenAI 兼容接口直连，
//  把中文（或混合）提示词翻成英文出图提示词。
//
//  动作名 youdaoTranslate 是历史遗留（两处面板都在监听），暂时不改名。
//  回包: { success, translated, translateId, error }
// ============================================================

var HostAPI = require('../host/host-api.js');
var auxLlm = require('../host/aux-llm.js');
var auxPrompts = require('../host/aux-prompts.js');

HostAPI.registerAction('youdaoTranslate', async function(data, ctx) {
    var text = data && data.text;
    var translateId = (data && data.translateId) || '';

    function fail(msg) {
        ctx.logToPanel('[翻译] 失败: ' + msg, 'error');
        ctx.sendToPanel('youdaoTranslateResult', { success: false, translated: '', translateId: translateId, error: msg });
    }

    if (!text || !String(text).trim()) {
        fail('没有可翻译的文本');
        return;
    }

    var cfg = auxLlm.readConfig(ctx);
    if (!cfg.ok) {
        fail(cfg.error);
        return;
    }

    try {
        var content = await auxLlm.callChat(cfg, {
            system: auxPrompts.TRANSLATE_SYSTEM,
            messages: [{ role: 'user', content: String(text) }],
            temperature: 0.2
        }, ctx);

        var out = auxLlm.stripWrappingQuotes(content);
        if (!out) {
            fail('语言模型返回了空译文');
            return;
        }

        ctx.logToPanel('[翻译] 完成 (' + out.length + ' 字, 模型 ' + cfg.model + ')', 'success');
        ctx.sendToPanel('youdaoTranslateResult', { success: true, translated: out, translateId: translateId });
    } catch (e) {
        fail((e && e.message) || String(e));
    }
}, { tileId: 'translate' });

module.exports = {};
