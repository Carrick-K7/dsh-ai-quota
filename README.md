# dsh-ai-quota

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows your AI subscription quotas & balances — **Codex**, **Kimi**, **DeepSeek**, **OpenCode Go** — in one place.

**English** · [中文文档](#中文文档)

- **Model tool `query_ai_quota`** — ask any agent session "check my AI quota" and get structured, human-readable results.
- **Settings page** — a new "AI Quota" section in Settings with per-window usage bars and balances, plus a manual refresh.
- **Composer chip** — a minimal one-line quota indicator under the input box that follows the currently selected model (toggleable in Settings).
- **Global auto-refresh** — the host re-queries all providers every 2 minutes (configurable via `refreshIntervalMs`, `0` disables) and serves a warm cache; the Settings page, composer chip and model tool all read it instantly.
- **Unified format** — every provider is normalized to `subscription` windows (`usedPercent` / `resetsAt`) or `balance` entries; one provider failing never affects the others.
- **Auth reuse** — Codex uses the local CLI login state; Kimi reuses the Kimi Code CLI OAuth session (auto-refreshes and atomically persists rotated tokens); DeepSeek / OpenCode Go read API keys from env vars or the DSH credentials seam. Keys and tokens never appear in tool output.

## Install

```sh
dsh plugin --profile web add github:Carrick-K7/dsh-ai-quota
```

The bundled `dsh.bundle.patch` declaration makes `dsh plugin` append it to `dsh.profile.bundles` automatically. Restart `dsh web` afterwards. Requires `pnpm` on PATH.

See the [中文文档](#中文文档) below for the full configuration table, per-provider data sources, and the unified format reference (both languages cover the same material — the Chinese section is the canonical full reference).

---

## 中文文档

DeepSeek Harness 插件：查询你的 AI 订阅额度/余额 —— **Codex**、**Kimi**、**DeepSeek**、**OpenCode Go**。提供两种入口：

1. **模型工具 `query_ai_quota`**：任何 agent 会话里直接问「查一下我的 AI 额度」，工具返回四个 provider 的结构化结果。
2. **设置页 UI**：设置侧边栏新增「AI 额度」页面，展示每个 provider 的用量进度条 / 余额，支持手动刷新；输入框下方还有一条跟随当前模型的极简额度行（可在设置页开关）。
3. **全局自动刷新**：host 侧每 2 分钟自动全量查询一次并写入缓存（`refreshIntervalMs` 可配，`0` 关闭）；设置页、chip、模型工具都读缓存，秒回。手动刷新按钮走 `refresh` 方法强制现场查询（并发去重为一次）。

## 安装

```sh
dsh plugin --profile web add github:Carrick-K7/dsh-ai-quota
# 或本地目录：dsh plugin --profile web add file:/path/to/dsh-ai-quota
```

包内 `dsh.bundle.patch` 声明会让 `dsh plugin` 把它自动追加到 `dsh.profile.bundles`（无需再手写 profile 的 `cordis.patch.yml`）。改完重启 `dsh web` 生效。

> 需要 pnpm 在 PATH 上。Host 侧与 client bundle 改动都要重启 web 进程才生效。

## 配置（插件行 config，均可选）

| Key | 默认值 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `15000` | 单 provider 查询超时（毫秒） |
| `refreshIntervalMs` | `120000` | 全局自动刷新间隔（毫秒），`0` = 关闭 |
| `deepseekBaseUrl` | `https://api.deepseek.com` | DeepSeek API 基地址 |
| `opencodeBaseUrl` | `https://opencode.ai/zen/go/v1/usage` | OpenCode Go 用量端点 |
| `codexCli` | `codex` | codex CLI 命令名或绝对路径 |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek API key 的环境变量名 |
| `opencodeGoApiKeyEnv` | `OPENCODE_GO_API_KEY` | OpenCode Go key 的环境变量名 |
| `kimiBaseUrl` | `https://api.kimi.com/coding/v1` | Kimi Code 用量端点基地址（追加 `/usages`） |
| `kimiOauthHost` | `https://auth.kimi.com` | Kimi OAuth 刷新端点（追加 `/api/oauth/token`） |
| `kimiClientId` | Kimi Code CLI 的公开 client id | OAuth client_id（一般无需改） |

密钥读取顺序：**环境变量**（名字可配置）→ DSH 凭据 seam（`$DSH_HOME/.credentials.yaml`，同名 key）→ **OpenCode CLI 的 `auth.json`**（`~/.local/share/opencode/auth.json` 的 `opencode-go` 条目）。Codex 无需 key，走 CLI 登录态；CLI 查找顺序：PATH → `~/.codex/bin` → nvm 版本目录。Kimi 走 **Kimi Code CLI 的 OAuth 登录态**（`~/.kimi-code/credentials/kimi-code.json`，旧版 `~/.kimi/credentials/kimi-code.json` 兜底）：access token 过期时插件会用 refresh token 自动续期并把轮换后的 token 原子写回原文件（与 CLI 共用登录态，不会踢掉 CLI；登录态彻底失效时提示重新 `kimi login`）。工具输出与 Remote 结果**永远不会包含 API key / token**。

## 统一展示格式（格式转换层）

Host 侧把所有 provider 原始数据归一化为统一格式（`kind` 区分两种计费模式），前端与模型工具按统一格式渲染：

| kind | 适用 | 字段 |
| --- | --- | --- |
| `subscription` | Codex、Kimi、OpenCode Go（订阅制） | `windows[]`：`name` / `usedPercent` / `remainingPercent`（由 used 换算）/ `resetsAt` / `limitWindowSeconds`；前端渲染分时间进度条 + 已用/剩余用量 |
| `balance` | DeepSeek（余额制） | `balances[]`：`currency` / `totalBalance` / `grantedBalance` / `toppedUpBalance` / `remainingAmount`（数值）；前端渲染剩余金额（纯余额，无明细） |

每个 provider 还带 `status`（`ok` / `not-configured` / `not-installed` / `error`）与 `error` 原因，单 provider 失败不影响其他。模型工具 `query_ai_quota` 的返回渲染为人类可读摘要（如 `Codex: 7d 已用 76%，剩余 24%`）。

## 各 provider 数据来源

| Provider | 来源 | 说明 |
| --- | --- | --- |
| Codex | 本地 `codex app-server --stdio` JSON-RPC（`account/rateLimits/read`） | 返回 5h / 7d 窗口的 `usedPercent` 与 `resetsAt`；未安装 codex CLI 时返回 `not-installed` |
| Kimi | `GET {kimiBaseUrl}/usages`（CLI OAuth 登录态，与 `kimi` CLI 的 `/usage` 面板同源） | 返回 5h 滚动窗口与每周配额（`limits[]` + 顶层 `usage`），会员等级映射为 `plan`；未找到登录态时返回 `not-configured` |
| DeepSeek | `GET {deepseekBaseUrl}/user/balance` | 返回 `is_available` 与各币种余额（总余额 / 充值 / 赠金），[官方文档](https://api-docs.deepseek.com/api/get-user-balance/) |
| OpenCode Go | `GET {opencodeBaseUrl}` | 返回 rolling / weekly / monthly 窗口的 `percent` 与 `resetsAt` |

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：`aiQuota` TypertRemoteService + `query_ai_quota` 工具注册 + 四个 provider 实现 |
| `typert.host.js` | Typert Host manifest（`exports["./typert"]`），strict 模式分发 |
| `client.js` | Client 半：`window.__ModuleLoader__.load` 浏览器 bundle，注册设置页 |
| `cordis.patch.yml` | bundle 补丁层，插入插件行 |

> ⚠️ Loader 契约：loader 以包的 **default export** 作为插件（函数/类/含 `apply` 的对象）。`index.js` 末尾的 `export default AiQuotaGateway` 不能删；漏掉会导致 `invalid plugin, expect function or object with an "apply" method` 启动失败。

## License

[MIT](./LICENSE)
