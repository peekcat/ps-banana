# API 供应商参考

## AJI（默认供应商）

### 基本信息

- 默认地址：`https://ai.ajiai.top`
- 认证方式：Bearer Token
- 计费单位：美元/张

### 模型与定价

| 模型ID | 显示名 | 1K | 2K | 4K |
|--------|--------|-----|-----|-----|
| AJbanana3 | 香蕉Pro | $0.15 | $0.16 | $0.18 |
| AJbanana2 | 香蕉2 | $0.05 | $0.06 | $0.06 |
| gemini-2.5-flash-image | 香蕉1 | $0.04 | 不支持 | 不支持 |

### 推荐选择

- **日常修图**：香蕉2（性价比最高）
- **高质量需求**：香蕉Pro
- **快速预览**：香蕉1（仅1K，最便宜）

## GRS

### 基本信息

- 国内地址：`https://grsai.dakka.com.cn`
- 海外地址：`https://grsaiapi.com`
- 认证方式：Bearer Token
- 计费单位：积分（整数）

### 模型与定价

| 模型ID | 1K | 2K | 4K |
|--------|-----|-----|-----|
| nano-banana-2 | 1 | 2 | 4 |
| nano-banana-fast | 1 | - | - |
| nano-banana | 1 | - | - |
| nano-banana-pro | 2 | 3 | 5 |
| nano-banana-pro-vt | 2 | 3 | 5 |
| nano-banana-pro-cl | 2 | 3 | 5 |
| nano-banana-pro-vip | 3 | 5 | - |
| nano-banana-pro-4k-vip | - | - | 8 |

### 积分查询

设置 → GRS 面板 → 点击「查询积分」

## Others（自定义供应商）

### 支持的格式

任何 OpenAI 兼容的 API 端点（`/v1beta/models/xxx:generateContent`）。

### 配置方法

1. 设置 → 连接 → 选择 Others
2. 从下拉菜单选择已有配置，或点击「新建」
3. 填写名称、API 地址、API Key
4. 点击「拉取」获取可用模型列表
5. 支持保存多套配置方案（如 OpenRouter、硅基流动等）

### 模型筛选

拉取模型时会自动筛选包含"banana"或"gemini-image"关键词的模型。

## SD WebUI Forge

### 本地使用

- 需要自行安装和运行 Forge WebUI
- 默认地址：`http://127.0.0.1:7860`
- 支持 img2img 和 txt2img
- 完整的 SD 参数控制（模型、采样器、LoRA、ControlNet）
- 免费使用（消耗本地 GPU 算力）

### 云端使用

- 通过插件云服务提供
- 登录后自动分配 Forge 实例
- 积分计费
- 无需本地 GPU

## ComfyUI

### 本地使用

- 需要自行安装和运行 ComfyUI
- 默认地址：`http://127.0.0.1:8188`
- 支持自定义工作流
- 动态参数 UI 渲染
- 免费使用（消耗本地 GPU 算力）

## 云服务

### 注册与登录

- 邮箱注册（需要验证码）
- 支持记住登录状态
- 离线模式（使用上次登录信息）

### 积分充值

使用卡密充值，在设置或 Forge 标签页的用户信息区操作。

### 公告系统

插件启动时会自动获取服务端公告，显示在设置标签页的「公告」区域。
