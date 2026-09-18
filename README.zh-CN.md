# dsh-ai-quota

DeepSeek Harness 插件：查询你的 AI 订阅额度 / 余额 —— **Codex**、**Kimi**、**GLM Coding Plan**、**DeepSeek**、**302.AI**、**OpenCode Go** 六个 provider 一处可见。

[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-topic%3Adsh--plugin-2ea44f?style=flat-square)](https://github.com/topics/dsh-plugin) [![GitHub stars](https://img.shields.io/github/stars/Carrick-K7/dsh-ai-quota?style=flat-square)](https://github.com/Carrick-K7/dsh-ai-quota) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

[English](README.md) · 中文

## 预览

![AI Quota 设置页](docs/settings.png)

*设置页：Codex / Kimi / GLM Coding Plan / OpenCode Go 的用量进度条 + DeepSeek / 302.AI 的简洁余额，手动刷新，以及跟随当前 provider 路由的输入框额度行。*

## 功能

- **模型工具 `query_ai_quota`**：任何 agent 会话里直接问「查一下我的 AI 额度」，返回人类可读摘要。
- **设置页**：设置侧边栏新增「AI 额度」页，每个 provider 的用量进度条 / 余额 + 手动刷新。
- **输入框额度行**：跟随当前 **provider 路由**（绝不看模型 ID —— 同一个模型可能由多个路由提供、额度彼此独立）的一行极简额度提示，新建页面与会话中都显示。
- **自动刷新**：host 每 `refreshIntervalMs`（默认 2 分钟）全量查询一次并写缓存，前端与工具秒回；`0` 关闭。此外**打开中的对话**每 60 秒静默重读一次当前 provider 的额度（不会闪加载态），所以长时间不关的会话不会一直停在打开时的旧余额；标签页隐藏时跳过，重新可见时立即补一次。
- **统一格式**：订阅制窗口 / 余额两种形态归一化，单个 provider 失败不影响其他。
- **跟随皮肤配色**:所有读数颜色都是 CSS 变量 —— 加载初音皮肤(dsk-miku-skin)时,输入框额度行与用量条变为柔和的初音青绿;没有皮肤时仍是原有的翠绿/琥珀/红三档。
- **不泄露密钥**：API key / token 永不进入工具输出、Remote 结果与日志。

## 安装

```sh
dsh plugin --profile web add github:Carrick-K7/dsh-ai-quota
# 或本地目录：dsh plugin --profile web add file:/path/to/dsh-ai-quota
```

包内 `cordis.patch.yml`（通过 package.json 的 `dsh.bundle.patch` 声明）会让 `dsh plugin` 自动把插件行追加到 `dsh.profile.bundles`。改完重启 `dsh web` 生效（需要 pnpm 在 PATH 上）。

## 配置（插件行 config，均可选）

| Key | 默认值 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `15000` | 单 provider 查询超时（毫秒） |
| `refreshIntervalMs` | `120000` | 全局自动刷新间隔（毫秒），`0` = 关闭 |
| `codexCli` | `codex` | codex CLI 命令名或绝对路径 |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | DSH 凭据引用名（回退同名环境变量） |
| `opencodeGoApiKeyEnv` | `OPENCODE_GO_API_KEY` | DSH 凭据引用名（回退同名环境变量） |
| `ai302ApiKeyEnv` | `AI_302_API_KEY` | DSH 凭据引用名（回退同名环境变量） |
| `glmApiKeyEnv` | `ZAI_CODING_CN_API_KEY` | GLM Coding Plan 的 DSH 凭据引用名（依次回退 `ZAI_CODING_API_KEY`、`GLM_CODING_API_KEY`） |
| `deepseekBaseUrl` | `https://api.deepseek.com` | DeepSeek API 基地址 |
| `opencodeBaseUrl` | `https://opencode.ai/zen/go/v1/usage` | OpenCode Go 用量端点 |
| `ai302BaseUrl` | `https://api.302.ai` | 302.AI API 基地址 |
| `glmBaseUrl` | `https://open.bigmodel.cn` | GLM Coding Plan 接口域名；只取 origin，所以填 `…/api/coding/paas/v4` 也可用。国际版填 `https://api.z.ai` |
| `kimiBaseUrl` | `https://api.kimi.com/coding/v1` | Kimi Code 用量端点基地址（追加 `/usages`） |
| `kimiOauthHost` | `https://auth.kimi.com` | Kimi OAuth 刷新端点（追加 `/api/oauth/token`） |
| `kimiClientId` | Kimi Code CLI 的公开 client id | OAuth client_id（一般无需改） |

## 输入框额度行的路由匹配

额度行读取当前所选模型的 **provider 路由**（如 `opencode-go-carrick`、`kimi-coding`、`deepseek-official`、`openai-codex`），绝不按模型 ID 匹配 —— OpenCode Go 路由下的 `kimi-k3` 属于 OpenCode Go 额度，而不是 Kimi 订阅。路由 id（或路由别名对应的 provider 显示名）包含 `302`、`opencode`、`codex`、`kimi`/`moonshot`、`deepseek`、`zai`/`zhipu`/`bigmodel`/`glm` 之一即被识别；其余路由不显示额度行，而不是显示另一个账号的余额。

额度行挂载期间每 60 秒重读一次该 provider（读 host 的暖缓存，不额外打上游接口）。若 host 快照本身已超过 10 分钟未更新（即 host 自动刷新被关闭或卡住），轮询会升级为真实查询，并限制为每个 provider 每 10 分钟最多一次。

## 密钥来源

- **DeepSeek / 302.AI / OpenCode Go**：优先走 DSH 凭据 seam 解析——`apiKeyEnv` 是凭据引用名（默认 `DEEPSEEK_API_KEY` / `AI_302_API_KEY` / `OPENCODE_GO_API_KEY`），因此配置在 DSH 的 key（如 `$DSH_HOME/.credentials.yaml`）优先；同名进程环境变量仅作兜底（非 DSH 独立部署）。OpenCode Go 额外回退 `~/.local/share/opencode/auth.json` 的 `opencode-go` 条目。
- **GLM Coding Plan**：同样走 DSH 凭据 seam，默认引用名 `ZAI_CODING_CN_API_KEY`，找不到时依次尝试 `ZAI_CODING_API_KEY`、`GLM_CODING_API_KEY`，所以国内版 / 国际版的 key 名都能直接用；国际版账号把 `glmBaseUrl` 改成 `https://api.z.ai`。
- **Codex / Kimi**：无需 key，复用本地 CLI 登录态（codex 走 PATH 上的 CLI；Kimi 复用 Kimi Code CLI 的 OAuth 会话，过期自动续期，彻底失效时提示重新 `kimi login`）。

## 各 provider 数据来源

| Provider | 来源 |
| --- | --- |
| Codex | 本地 `codex app-server --stdio` JSON-RPC（`account/rateLimits/read`）— 5h / 7d 窗口 |
| Kimi | `GET {kimiBaseUrl}/usages`（Kimi Code CLI 的 OAuth 登录态） |
| GLM Coding Plan | `GET {glmBaseUrl}/api/monitor/usage/quota/limit`（Bearer key）— 5 小时额度周期 / 每周额度 / 每月 MCP 工具额度 |
| DeepSeek | `GET {deepseekBaseUrl}/user/balance`（Bearer key） |
| 302.AI | `GET {ai302BaseUrl}/dashboard/balance`（Bearer key） |
| OpenCode Go | `GET {opencodeBaseUrl}`（Bearer key） |

## License

[MIT](./LICENSE)
