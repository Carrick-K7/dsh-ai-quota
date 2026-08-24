# dsh-ai-quota

DeepSeek Harness 插件：查询你的 AI 订阅额度 / 余额 —— **Codex**、**Kimi**、**DeepSeek**、**OpenCode Go** 四个 provider 一处可见。

[English](README.md) · 中文

## 功能

1. **模型工具 `query_ai_quota`**：任何 agent 会话里直接问「查一下我的 AI 额度」，工具返回每个 provider 的人类可读摘要。
2. **设置页 UI**：设置侧边栏新增「AI 额度」页，展示每个 provider 的用量进度条 / 余额，支持手动刷新；输入框下方还有一条跟随当前模型的极简额度行（可在设置页开关）。
3. **全局自动刷新**：host 侧每 `refreshIntervalMs`（默认 2 分钟）自动全量查询一次并写入缓存；设置页、chip、模型工具都读缓存，秒回。手动刷新按钮走 `refresh` 方法强制现场查询（并发去重为一次）。
4. **统一格式**：所有 provider 归一化为 `subscription`（窗口）或 `balance`（余额）两种形状，单个 provider 失败不影响其他。

## 安装

```sh
dsh plugin --profile web add github:Carrick-K7/dsh-ai-quota
# 或本地目录：dsh plugin --profile web add file:/path/to/dsh-ai-quota
```

包内 `cordis.patch.yml`（通过 package.json 的 `dsh.bundle.patch` 声明）会让 `dsh plugin` 把它自动追加到 `dsh.profile.bundles`，无需手写 profile 的补丁。改完重启 `dsh web` 生效。

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

## 密钥来源

- **DeepSeek / OpenCode Go**：环境变量（名字可配置）→ DSH 凭据 seam（`$DSH_HOME/.credentials.yaml`，同名 key）→ OpenCode Go 额外兜底 `~/.local/share/opencode/auth.json` 的 `opencode-go` 条目。
- **Codex**：无需 key，走本地 CLI 登录态。CLI 查找顺序：PATH → `~/.codex/bin` → nvm 版本目录。
- **Kimi**：走 Kimi Code CLI 的 OAuth 登录态（`~/.kimi-code/credentials/kimi-code.json`，旧版 `~/.kimi/credentials/kimi-code.json` 兜底）。access token 过期时插件用 refresh token 自动续期并原子写回原文件（`0600`，与 CLI 共用登录态，不会踢掉 CLI）；登录态彻底失效时提示重新 `kimi login`。

工具输出与 Remote 结果**永远不会包含 API key / token**。

## 统一展示格式（格式转换层）

Host 侧把所有 provider 原始数据归一化为统一格式（`kind` 区分两种计费模式），前端与模型工具按统一格式渲染：

| kind | 适用 | 字段 |
| --- | --- | --- |
| `subscription` | Codex、Kimi、OpenCode Go（订阅制） | `windows[]`：`name` / `usedPercent` / `remainingPercent`（由 used 换算）/ `resetsAt` / `limitWindowSeconds`；前端渲染分时间进度条 + 已用/剩余用量 |
| `balance` | DeepSeek（余额制） | `balances[]`：`currency` / `totalBalance` / `grantedBalance` / `toppedUpBalance` / `remainingAmount`（数值）；前端渲染剩余金额 |

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
