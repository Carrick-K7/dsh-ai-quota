# dsh-ai-quota

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that shows your AI subscription quotas & balances — **Codex**, **Kimi**, **DeepSeek**, **OpenCode Go** — in one place.

English · [中文](README.zh-CN.md)

## Features

- **Model tool `query_ai_quota`** — ask any agent session to check your quota; returns a human-readable summary.
- **Settings page** — an "AI Quota" section with per-window usage bars and balances, plus manual refresh.
- **Composer chip** — a one-line quota indicator that follows the selected model (toggleable in Settings).
- **Auto-refresh** — the host re-queries all providers every `refreshIntervalMs` (default 2 min; `0` disables) and serves a warm cache, so every surface reads instantly.
- **Unified format** — providers are normalized to `subscription` windows or `balance` entries; one provider failing never affects the others.
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
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | Env var name for the DeepSeek API key |
| `opencodeGoApiKeyEnv` | `OPENCODE_GO_API_KEY` | Env var name for the OpenCode Go key |
| `deepseekBaseUrl` | `https://api.deepseek.com` | DeepSeek API base URL |
| `opencodeBaseUrl` | `https://opencode.ai/zen/go/v1/usage` | OpenCode Go usage endpoint |
| `kimiBaseUrl` | `https://api.kimi.com/coding/v1` | Kimi usage endpoint base (appends `/usages`) |
| `kimiOauthHost` | `https://auth.kimi.com` | Kimi OAuth refresh endpoint (appends `/api/oauth/token`) |
| `kimiClientId` | Kimi Code CLI's public client id | OAuth `client_id` (usually unchanged) |

## Credentials

- **DeepSeek / OpenCode Go**: env var named by config (defaults `DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`), falling back to the DSH credentials seam; OpenCode Go also falls back to the `opencode-go` entry in `~/.local/share/opencode/auth.json`.
- **Codex / Kimi**: no keys — the local CLI login state is reused (codex CLI on PATH; Kimi Code CLI's OAuth session, auto-refreshed when expired, `kimi login` again if it is gone).

## Data sources

| Provider | Source |
| --- | --- |
| Codex | Local `codex app-server --stdio` JSON-RPC (`account/rateLimits/read`) — 5h / 7d windows |
| Kimi | `GET {kimiBaseUrl}/usages` (Kimi Code CLI's OAuth login state) |
| DeepSeek | `GET {deepseekBaseUrl}/user/balance` (bearer key) |
| OpenCode Go | `GET {opencodeBaseUrl}` (bearer key) |

## License

[MIT](./LICENSE)
