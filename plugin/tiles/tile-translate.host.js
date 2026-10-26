// ============================================================
//  tile-translate.host.js
//  翻译后端处理器
//
//  原版把翻译请求转发给作者服务器 (preset-server 的翻译代理, 有道密钥在服务端)。
//  作者停服后这条链路已经删掉; 本阶段先给出明确提示, 阶段 B 会改成
//  「用用户自己配置的 OpenAI 兼容接口直连」(见 docs/去云化评估.md §3.2)。
// ============================================================

var HostAPI = require('../host/host-api.js');

HostAPI.registerAction('youdaoTranslate', async function(data, ctx) {
    ctx.sendToPanel('youdaoTranslateResult', {
        success: false,
        error: '翻译功能正在改造中: 当前版本不再连接作者服务器, 阶段 B 会改成用你自己配置的 LLM 直连',
        translateId: (data && data.translateId) || ''
    });
}, { tileId: 'translate' });
