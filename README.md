# dsh-ai-quota

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows your AI subscription quotas & balances — **Codex**, **Kimi**, **GLM Coding Plan**, **DeepSeek**, **302.AI**, **OpenCode Go** — in one place.

[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-topic%3Adsh--plugin-2ea44f?style=flat-square)](https://github.com/topics/dsh-plugin) [![GitHub stars](https://img.shields.io/github/stars/Carrick-K7/dsh-ai-quota?style=flat-square)](https://github.com/Carrick-K7/dsh-ai-quota) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

English · [中文](README.zh-CN.md)

## Preview

![AI Quota settings page](docs/settings.png)

*Settings page: per-window usage bars (Codex / Kimi / GLM Coding Plan / OpenCode Go) and plain balances (DeepSeek, 302.AI), with manual refresh and a composer chip that follows the selected provider route.*

## Features

- **Model tool `query_ai_quota`** — ask any agent session to check your quota; returns a human-readable summary.
- **Settings page** — an "AI Quota" section with per-window usage bars and balances, plus manual refresh.
- **Composer chip** — a one-line quota indicator that follows the selected **provider route** (never the model id: the same model can be served by several routes with independent quotas), on both the new-chat page and in sessions.
- **Auto-refresh** — the host re-queries all providers every `refreshIntervalMs` (default 2 min; `0` disables) and serves a warm cache, so every surface reads instantly. An **open conversation** additionally re-reads its provider's quota every 60 s (silently, without a loading flicker), so a session left running for a while never keeps the balance it loaded with; a hidden tab is skipped and caught up when it becomes visible again.
- **Unified format** — providers are normalized to `subscription` windows or `balance` entries; one provider failing never affects the others.
- **Skin-aware palette** — every readout color is a CSS variable: with the [dsh-miku-skin](https://github.com/topics/dsh-plugin) Hatsune skin loaded the chip and usage bars turn soft Miku teal, and without it they keep the shipped emerald/amber/red severity colors.
- **No secrets in output** — API keys and tokens never appear in tool output or logs.

## Install

```sh
dsh plugin --profile web add github:Carrick-K7/dsh-ai-quota
```

The bundled `cordis.patch.yml` declaration makes `dsh plugin` append the plugin row to `dsh.profile.bundles` automatically. Restart `dsh web` afterwards (`pnpm` must be on PATH).

## Configuration

All keys optional, defaults shown.

| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `15000` | Per-provider query timeout (ms) |
| `refreshIntervalMs` | `120000` | Auto-refresh interval (ms); `0` = off |
| `codexCli` | `codex` | codex CLI command or absolute path |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | DSH credential ref (fallback: same-named env var) |
| `opencodeGoApiKeyEnv` | `OPENCODE_GO_API_KEY` | DSH credential ref (fallback: same-named env var) |
| `ai302ApiKeyEnv` | `AI_302_API_KEY` | DSH credential ref (fallback: same-named env var) |
| `glmApiKeyEnv` | `ZAI_CODING_CN_API_KEY` | DSH credential ref for the GLM Coding Plan key (falls back to `ZAI_CODING_API_KEY`, then `GLM_CODING_API_KEY`) |
| `deepseekBaseUrl` | `https://api.deepseek.com` | DeepSeek API base URL |
| `opencodeBaseUrl` | `https://opencode.ai/zen/go/v1/usage` | OpenCode Go usage endpoint |
| `ai302BaseUrl` | `https://api.302.ai` | 302.AI API base URL |
| `glmBaseUrl` | `https://open.bigmodel.cn` | GLM Coding Plan API host; only the origin is used, so a coding base like `…/api/coding/paas/v4` works. International accounts: `https://api.z.ai` |
| `kimiBaseUrl` | `https://api.kimi.com/coding/v1` | Kimi usage endpoint base (appends `/usages`) |
| `kimiOauthHost` | `https://auth.kimi.com` | Kimi OAuth refresh endpoint (appends `/api/oauth/token`) |
| `kimiClientId` | Kimi Code CLI's public client id | OAuth `client_id` (usually unchanged) |

## Composer chip routing

The chip reads the **provider route** of the current model selection (e.g. `opencode-go-carrick`, `kimi-coding`, `deepseek-official`, `openai-codex`) and never the model id — `kimi-k3` on an OpenCode Go route is an OpenCode Go quota, not a Kimi one. A route is recognized when its id (or, for an opaque alias, its provider display name) contains one of `302`, `opencode`, `codex`, `kimi`/`moonshot`, `deepseek`, `zai`/`zhipu`/`bigmodel`/`glm`. Any other route shows no chip rather than another account's balance.

The chip then re-reads that provider every 60 s while it is mounted, reading the host's warm cache (so no extra upstream calls). If the host snapshot itself is older than 10 min — i.e. the host auto-refresh is off or stalled — the poll escalates to a real query, throttled to once per 10 min per provider.

## Credentials

- **DeepSeek / 302.AI / OpenCode Go**: key resolved through the DSH credentials seam first — `apiKeyEnv` is a credential ref (defaults `DEEPSEEK_API_KEY` / `AI_302_API_KEY` / `OPENCODE_GO_API_KEY`), so a key stored in DSH (e.g. `$DSH_HOME/.credentials.yaml`) wins; a same-named process env var is the fallback for standalone deployments. OpenCode Go also falls back to the `opencode-go` entry in `~/.local/share/opencode/auth.json`.
- **GLM Coding Plan**: key resolved through the same credentials seam; the default ref is `ZAI_CODING_CN_API_KEY`, with `ZAI_CODING_API_KEY` and `GLM_CODING_API_KEY` tried next, so either region's key name works. Point `glmBaseUrl` at `https://api.z.ai` for an international coding plan.
- **Codex / Kimi**: no keys — the local CLI login state is reused (codex CLI on PATH; Kimi Code CLI's OAuth session, auto-refreshed when expired, `kimi login` again if it is gone).

## Data sources

| Provider | Source |
| --- | --- |
| Codex | Local `codex app-server --stdio` JSON-RPC (`account/rateLimits/read`) — 5h / 7d windows |
| Kimi | `GET {kimiBaseUrl}/usages` (Kimi Code CLI's OAuth login state) |
| GLM Coding Plan | `GET {glmBaseUrl}/api/monitor/usage/quota/limit` (bearer key) — 5h credit cycle / weekly quota / monthly MCP budget |
| DeepSeek | `GET {deepseekBaseUrl}/user/balance` (bearer key) |
| 302.AI | `GET {ai302BaseUrl}/dashboard/balance` (bearer key) |
| OpenCode Go | `GET {opencodeBaseUrl}` (bearer key) |

## License

[MIT](./LICENSE)
