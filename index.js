// Host half of the dsh-ai-quota plugin.
//
// Two faces of one capability:
//   1. A model tool `query_ai_quota` (registered via the host `tools`
//      registry) so any agent session can ask for balances directly.
//   2. A Typert Remote service `aiQuota` whose `query()` method is
//      callable from the browser Settings page over the /api RPC carrier.
//      Strict-mode dispatch is driven by typert.host.js (exports["./typert"]),
//      so no @Remote decorator is required here.
//
// Providers:
//   - Codex      : local `codex app-server --stdio` JSON-RPC (NDJSON),
//                  account/rateLimits/read -> rolling windows (5h / 7d).
//   - Kimi       : GET {kimiBaseUrl}/usages with the Kimi Code CLI's OAuth
//                  login state (~/.kimi-code/credentials), refreshing the
//                  access token via {kimiOauthHost}/api/oauth/token when
//                  expired; 5h / weekly quota windows.
//   - DeepSeek   : GET {deepseekBaseUrl}/user/balance with a Bearer key.
//   - OpenCode Go: GET {opencodeBaseUrl} (https://opencode.ai/zen/go/v1/usage)
//                  with a Bearer key; rolling / weekly / monthly windows.
//
// API keys are read from environment variables whose NAMES are configurable
// through the plugin row config (deepseekApiKeyEnv / opencodeGoApiKeyEnv),
// with a fallback to the DSH credentials seam for the same names. Keys are
// never included in tool output, Remote results, or logs.

import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_CODEX_CLI = "codex";
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com";
// The Kimi Code CLI's public OAuth client id (device-code flow); the plugin
// only ever REFRESHES existing login state, it never starts a login.
const DEFAULT_KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export const Config = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  deepseekBaseUrl: z.string().default(DEFAULT_DEEPSEEK_BASE_URL),
  opencodeBaseUrl: z.string().default(DEFAULT_OPENCODE_BASE_URL),
  codexCli: z.string().default(DEFAULT_CODEX_CLI),
  deepseekApiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  opencodeGoApiKeyEnv: z.string().default("OPENCODE_GO_API_KEY"),
  kimiBaseUrl: z.string().default(DEFAULT_KIMI_BASE_URL),
  kimiOauthHost: z.string().default(DEFAULT_KIMI_OAUTH_HOST),
  kimiClientId: z.string().default(DEFAULT_KIMI_CLIENT_ID),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a command: explicit path, PATH walk, then common install
 * locations (codex's own ~/.codex/bin, nvm version dirs) so a CLI
 * installed outside the service PATH is still found.
 */
export function findOnPath(command) {
  if (command.includes("/") || command.includes("\\")) {
    try {
      if (existsSync(command) && statSync(command).isFile()) return command;
    } catch {
      /* ignore */
    }
    return undefined;
  }
  const names =
    process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  const dirs = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) dirs.push(dir);
  }
  try {
    const home = homedir();
    dirs.push(path.join(home, ".codex", "bin"));
    const nvmVersions = path.join(home, ".nvm", "versions", "node");
    for (const entry of readdirSync(nvmVersions, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(nvmVersions, entry.name, "bin"));
    }
  } catch {
    /* ignore */
  }
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/**
 * Resolve an API key: process environment first, then the DSH credentials
 * seam (same name). Returns undefined when neither source has it.
 */
async function resolveKey(ctx, envName) {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const credentials = ctx.get("credentials");
  if (credentials) {
    try {
      const cred = await credentials.resolve(credentialRef(envName));
      if (cred && typeof cred.value === "string" && cred.value.length > 0) return cred.value;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * OpenCode Go key fallback: the OpenCode CLI's own auth.json
 * (opencode-go entry, fallback opencode, type "api").
 */
async function resolveOpencodeAuthKey() {
  try {
    const authPath = path.join(homedir(), ".local", "share", "opencode", "auth.json");
    const raw = JSON.parse(await readFile(authPath, "utf8"));
    const entry = raw["opencode-go"] ?? raw["opencode"];
    if (entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) {
      return entry.key;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ---------------------------------------------------------------------------
// Codex provider: `codex app-server --stdio` JSON-RPC (newline-delimited JSON)
// ---------------------------------------------------------------------------

function classifyCodexWindow(mins) {
  if (mins === 300) return "5h";
  if (mins === 10080) return "7d";
  if (typeof mins === "number") return `${mins}m`;
  return "unknown";
}

/** 归一化 resetsAt：app-server 返回 Unix 秒级时间戳，统一转 ISO 字符串。 */
function toIso(resetsAt) {
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    const d = new Date(resetsAt * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof resetsAt === "string" && resetsAt.length > 0) return resetsAt;
  return null;
}

/** 提取一个 snapshot 里的单个窗口（primary/secondary）。 */
function snapshotWindow(w) {
  if (!w || typeof w !== "object") return null;
  const mins = w.windowDurationMins;
  return {
    name: classifyCodexWindow(mins),
    usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null,
    resetsAt: toIso(w.resetsAt),
    limitWindowSeconds: typeof mins === "number" ? mins * 60 : null,
  };
}

/**
 * 适配 account/rateLimits/read 响应（与 CLI 内 /status 同源）：
 * - 主限额 aggregate.rateLimits 的 primary/secondary 窗口（resetsAt 为秒级
 *   时间戳，转 ISO）；
 * - planType 取自 aggregate（响应顶层同名字段可能缺失）；
 * - rateLimitsByLimitId 中额外的限额（如 GPT-5.3-Codex-Spark）作为附加窗口，
 *   去重（排除与 aggregate 相同的 limitId）。
 */
function adaptCodexRateLimits(result) {
  const windows = [];
  let plan = null;
  const aggregate = result.rateLimits;
  if (aggregate && typeof aggregate === "object") {
    if (typeof aggregate.planType === "string") plan = aggregate.planType;
    for (const slot of ["primary", "secondary"]) {
      const w = snapshotWindow(aggregate[slot]);
      if (w) windows.push(w);
    }
  }
  if (!plan && typeof result.planType === "string") plan = result.planType;
  const byLimitId = result.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === "object" && aggregate) {
    const aggregateId = aggregate.limitId || "codex";
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      if (limitId === aggregateId || limitId === "codex" || snapshot === aggregate) continue;
      const label =
        typeof snapshot.limitName === "string" && snapshot.limitName.length > 0
          ? snapshot.limitName
          : limitId;
      for (const slot of ["primary", "secondary"]) {
        const w = snapshotWindow(snapshot[slot]);
        if (w) windows.push({ ...w, name: `${label} ${w.name}` });
      }
    }
  }
  return { plan, windows };
}

/**
 * Query Codex rate-limit windows through the CLI's app-server.
 * Resolves { kind: "not-installed" } | { kind: "error", error } |
 * { kind: "ok", plan, windows }.
 */
export function codexRateLimits(codexCli, timeoutMs) {
  return new Promise((resolve) => {
    const codexPath = findOnPath(codexCli);
    if (!codexPath) {
      resolve({ kind: "not-installed" });
      return;
    }
    let child;
    try {
      child = spawn(codexPath, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ kind: "not-installed" });
      return;
    }

    let buffer = "";
    const pending = new Map();
    let finished = false;
    const timer = setTimeout(() => finish({ kind: "error", error: "timeout" }), timeoutMs);

    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(value);
    }

    child.on("error", () => finish({ kind: "error", error: "spawn-failed" }));
    child.on("exit", (code) => {
      if (!finished) finish({ kind: "error", error: code === null ? "killed" : `exit-${code}` });
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && typeof msg.id !== "undefined" && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        }
      }
    });
    child.stderr.on("data", () => {});

    function send(obj) {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        finish({ kind: "error", error: "io" });
      }
    }
    function call(method, id, params) {
      return new Promise((resolveCall) => {
        const t = setTimeout(() => {
          pending.delete(id);
          finish({ kind: "error", error: "timeout" });
        }, timeoutMs);
        pending.set(id, { resolve: resolveCall, timer: t });
        send({ method, id, ...(params === undefined ? {} : { params }) });
      });
    }

    (async () => {
      try {
        const init = await call("initialize", 1, {
          clientInfo: { name: "dsh-ai-quota", title: "dsh-ai-quota", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        if (!init || init.error || !init.result) {
          finish({ kind: "error", error: "initialize-failed" });
          return;
        }
        send({ method: "initialized" });
        const limits = await call("account/rateLimits/read", 2);
        if (
          !limits ||
          limits.error ||
          !limits.result ||
          typeof limits.result !== "object"
        ) {
          finish({ kind: "error", error: "rate-limits-unavailable" });
          return;
        }
        finish({ kind: "ok", ...adaptCodexRateLimits(limits.result) });
      } catch {
        finish({ kind: "error", error: "rpc-failed" });
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// DeepSeek provider: GET {base}/user/balance
// ---------------------------------------------------------------------------

async function queryDeepSeek(ctx, config, timeoutMs) {
  const key = await resolveKey(ctx, config.deepseekApiKeyEnv);
  if (!key) {
    return {
      status: "not-configured",
      keyConfigured: false,
      error: "no-api-key",
      available: null,
      balances: [],
    };
  }
  try {
    const res = await fetchWithTimeout(
      `${String(config.deepseekBaseUrl).replace(/\/+$/, "")}/user/balance`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      timeoutMs,
    );
    if (res.status === 401) {
      return { status: "error", keyConfigured: true, error: "unauthorized", available: null, balances: [] };
    }
    if (!res.ok) {
      return { status: "error", keyConfigured: true, error: `http-${res.status}`, available: null, balances: [] };
    }
    const body = await res.json();
    const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];
    return {
      status: "ok",
      keyConfigured: true,
      error: null,
      available: body && typeof body.is_available === "boolean" ? body.is_available : null,
      balances: infos.map((b) => ({
        currency: typeof b.currency === "string" ? b.currency : "?",
        totalBalance: typeof b.total_balance === "string" ? b.total_balance : null,
        grantedBalance: typeof b.granted_balance === "string" ? b.granted_balance : null,
        toppedUpBalance: typeof b.topped_up_balance === "string" ? b.topped_up_balance : null,
      })),
    };
  } catch {
    return { status: "error", keyConfigured: true, error: "network", available: null, balances: [] };
  }
}

// ---------------------------------------------------------------------------
// OpenCode Go provider: GET {base} with rolling / weekly / monthly windows
// ---------------------------------------------------------------------------

function pickWindow(w) {
  if (!w || typeof w !== "object") return null;
  const usedPercent = typeof w.percent === "number" ? w.percent : Number(w.percent);
  return {
    name: null, // set by the caller
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
    limitWindowSeconds: null,
  };
}

async function queryOpencodeGo(ctx, config, timeoutMs) {
  let key = await resolveKey(ctx, config.opencodeGoApiKeyEnv);
  if (!key) key = await resolveOpencodeAuthKey();
  if (!key) {
    return { status: "not-configured", keyConfigured: false, error: "no-api-key", windows: [] };
  }
  try {
    const res = await fetchWithTimeout(
      config.opencodeBaseUrl,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      timeoutMs,
    );
    if (res.status === 401) {
      return { status: "error", keyConfigured: true, error: "unauthorized", windows: [] };
    }
    if (!res.ok) {
      return { status: "error", keyConfigured: true, error: `http-${res.status}`, windows: [] };
    }
    const body = await res.json();
    const usage = body && typeof body === "object" && body.usage ? body.usage : body;
    const windows = [];
    for (const [name, w] of [
      ["rolling", usage && usage.rolling],
      ["weekly", usage && usage.weekly],
      ["monthly", usage && usage.monthly],
    ]) {
      const picked = pickWindow(w);
      if (picked) {
        picked.name = name;
        windows.push(picked);
      }
    }
    return { status: "ok", keyConfigured: true, error: null, windows };
  } catch {
    return { status: "error", keyConfigured: true, error: "network", windows: [] };
  }
}

// ---------------------------------------------------------------------------
// Kimi provider: OAuth login state from the Kimi Code CLI + GET {base}/usages
// ---------------------------------------------------------------------------

const KIMI_CREDENTIAL_PATHS = [
  path.join(homedir(), ".kimi-code", "credentials", "kimi-code.json"),
  path.join(homedir(), ".kimi", "credentials", "kimi-code.json"),
];

/** Read the CLI's credential store (access + refresh token). */
async function readKimiCredentials() {
  for (const file of KIMI_CREDENTIAL_PATHS) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (raw && typeof raw.access_token === "string" && raw.access_token.length > 0) {
        return { file, creds: raw };
      }
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/**
 * Refresh the access token through the CLI's OAuth host and persist the
 * rotated tokens back to the credential file (atomically), so the CLI keeps
 * working with the same state. If the CLI itself refreshed concurrently
 * (refresh_token changed on disk), the on-disk token wins and ours is
 * discarded.
 */
async function refreshKimiCredentials(stored, config, timeoutMs) {
  const creds = stored.creds;
  if (typeof creds.refresh_token !== "string" || creds.refresh_token.length === 0) {
    return { ok: false, error: "no-credentials" };
  }
  let tok;
  try {
    const res = await fetchWithTimeout(
      `${String(config.kimiOauthHost || DEFAULT_KIMI_OAUTH_HOST).replace(/\/+$/, "")}/api/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: String(config.kimiClientId || DEFAULT_KIMI_CLIENT_ID),
          grant_type: "refresh_token",
          refresh_token: creds.refresh_token,
        }).toString(),
      },
      timeoutMs,
    );
    if (res.status === 401 || res.status === 403) return { ok: false, error: "login-expired" };
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    tok = await res.json();
  } catch {
    return { ok: false, error: "network" };
  }
  if (!tok || typeof tok.access_token !== "string" || tok.access_token.length === 0) {
    return { ok: false, error: "login-expired" };
  }
  const merged = {
    ...creds,
    access_token: tok.access_token,
    refresh_token: typeof tok.refresh_token === "string" && tok.refresh_token ? tok.refresh_token : creds.refresh_token,
    expires_in: typeof tok.expires_in === "number" ? tok.expires_in : 900,
    expires_at: Date.now() / 1000 + (typeof tok.expires_in === "number" ? tok.expires_in : 900),
    scope: typeof tok.scope === "string" ? tok.scope : creds.scope,
    token_type: typeof tok.token_type === "string" ? tok.token_type : creds.token_type,
  };
  try {
    const latest = JSON.parse(await readFile(stored.file, "utf8"));
    if (latest && latest.refresh_token === creds.refresh_token) {
      const tmp = stored.file + ".tmp";
      await writeFile(tmp, JSON.stringify(merged), { mode: 0o600 });
      await rename(tmp, stored.file);
      return { ok: true, creds: merged };
    }
    // The CLI refreshed concurrently: prefer the freshest on-disk token.
    if (
      latest &&
      typeof latest.access_token === "string" &&
      typeof latest.expires_at === "number" &&
      Date.now() < latest.expires_at * 1000 - 30000
    ) {
      return { ok: true, creds: latest };
    }
  } catch {
    /* fall through: use the in-memory token even if persisting failed */
  }
  return { ok: true, creds: merged };
}

/** Map an upstream quota window ({duration, timeUnit}) to a display name. */
function kimiWindowName(window) {
  if (!window || typeof window !== "object") return "unknown";
  const d = Number(window.duration);
  const unit = window.timeUnit;
  if (!Number.isFinite(d)) return "unknown";
  if (unit === "TIME_UNIT_MINUTE") {
    if (d === 300) return "5h";
    if (d === 60) return "1h";
    if (d === 1440) return "1d";
    if (d === 10080) return "weekly";
    return `${d}m`;
  }
  if (unit === "TIME_UNIT_HOUR") return d === 1 ? "1h" : `${d}h`;
  if (unit === "TIME_UNIT_DAY") {
    if (d === 1) return "1d";
    if (d === 7) return "weekly";
    return `${d}d`;
  }
  if (unit === "TIME_UNIT_WEEK") return "weekly";
  return "unknown";
}

function kimiUsageWindow(name, detail) {
  if (!detail || typeof detail !== "object") return null;
  const limit = Number(detail.limit);
  // 重置后上游会省略 used（只剩 limit + remaining），用 limit-remaining 推导。
  let used = Number(detail.used);
  if (!Number.isFinite(used)) {
    const remaining = Number(detail.remaining);
    used = Number.isFinite(remaining) && Number.isFinite(limit) ? limit - remaining : NaN;
  }
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    name,
    usedPercent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
    resetsAt: typeof detail.resetTime === "string" ? detail.resetTime : null,
    limitWindowSeconds: null,
  };
}

/**
 * Adapt the /usages payload. Semantics mirror the CLI's /usage panel:
 * - `limits[]` are the short windows (e.g. 300 minutes -> "5h");
 * - top-level `usage` is the weekly quota (the CLI defaults its window to
 *   1 week when the payload omits it).
 */
function adaptKimiUsage(body) {
  const windows = [];
  const limits = body && Array.isArray(body.limits) ? body.limits : [];
  for (const item of limits) {
    const w = kimiUsageWindow(kimiWindowName(item && item.window), item && item.detail);
    if (w) windows.push(w);
  }
  if (body && body.usage) {
    const w = kimiUsageWindow("weekly", body.usage);
    if (w) windows.push(w);
  }
  return windows;
}

function kimiPlanName(body) {
  const level = body && body.user && body.user.membership && body.user.membership.level;
  if (typeof level !== "string" || level.length === 0) return null;
  const known = {
    LEVEL_FREE: "Free",
    LEVEL_BASIC: "Basic",
    LEVEL_INTERMEDIATE: "Intermediate",
    LEVEL_ADVANCED: "Advanced",
    LEVEL_ULTIMATE: "Ultimate",
  };
  if (known[level]) return known[level];
  if (level.startsWith("LEVEL_")) {
    const rest = level.slice(6).toLowerCase();
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return level;
}

export async function queryKimi(ctx, config, timeoutMs) {
  const stored = await readKimiCredentials();
  if (!stored) {
    return { status: "not-configured", keyConfigured: false, error: "no-credentials", plan: null, windows: [] };
  }
  let creds = stored.creds;
  const expiresAtMs = typeof creds.expires_at === "number" ? creds.expires_at * 1000 : 0;
  if (Date.now() > expiresAtMs - 30000) {
    const refreshed = await refreshKimiCredentials(stored, config, timeoutMs);
    if (!refreshed.ok) {
      const loginExpired = refreshed.error === "login-expired";
      return {
        status: loginExpired ? "not-configured" : "error",
        keyConfigured: false,
        error: refreshed.error,
        plan: null,
        windows: [],
      };
    }
    creds = refreshed.creds;
  }
  try {
    const res = await fetchWithTimeout(
      `${String(config.kimiBaseUrl || DEFAULT_KIMI_BASE_URL).replace(/\/+$/, "")}/usages`,
      { headers: { Authorization: `Bearer ${creds.access_token}`, Accept: "application/json" } },
      timeoutMs,
    );
    if (res.status === 401) {
      return { status: "error", keyConfigured: true, error: "unauthorized", plan: null, windows: [] };
    }
    if (!res.ok) {
      return { status: "error", keyConfigured: true, error: `http-${res.status}`, plan: null, windows: [] };
    }
    const body = await res.json();
    return {
      status: "ok",
      keyConfigured: true,
      error: null,
      plan: kimiPlanName(body),
      windows: adaptKimiUsage(body),
    };
  } catch {
    return { status: "error", keyConfigured: true, error: "network", plan: null, windows: [] };
  }
}

// ---------------------------------------------------------------------------
// The plugin: a TypertRemoteService that also registers the model tool
// ---------------------------------------------------------------------------

function normalizeCodex(r) {
  if (r.kind === "not-installed") return { status: "not-installed", error: null, plan: null, windows: [] };
  if (r.kind === "error") return { status: "error", error: r.error, plan: null, windows: [] };
  return { status: "ok", error: null, plan: r.plan, windows: r.windows };
}

// ---------------------------------------------------------------------------
// 格式转换层：把各 provider 原始数据归一化为统一展示格式。
// - 订阅制 (kind: "subscription")：windows[]，每窗口含 usedPercent /
//   remainingPercent / resetsAt，前端渲染分时间进度条与剩余用量。
// - 余额制 (kind: "balance")：balances[]，每币种含 remainingAmount 数值与
//   字符串明细，前端渲染剩余金额。
// 所有字段均为 JSON 安全标量；任何 provider 失败只影响自身，不影响整体。
// ---------------------------------------------------------------------------

function toSubscriptionWindows(rawWindows) {
  return (rawWindows || []).map((w) => {
    const used = w && typeof w.usedPercent === "number" ? w.usedPercent : null;
    return {
      name: w && typeof w.name === "string" ? w.name : "unknown",
      usedPercent: used,
      remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
      resetsAt: w && typeof w.resetsAt === "string" ? w.resetsAt : null,
      limitWindowSeconds:
        w && typeof w.limitWindowSeconds === "number" ? w.limitWindowSeconds : null,
    };
  });
}

function toBalanceInfos(rawBalances) {
  return (rawBalances || []).map((b) => {
    const total = typeof b.totalBalance === "string" ? b.totalBalance : null;
    const num = total === null ? NaN : Number(total);
    return {
      currency: typeof b.currency === "string" ? b.currency : "?",
      totalBalance: total,
      grantedBalance: typeof b.grantedBalance === "string" ? b.grantedBalance : null,
      toppedUpBalance: typeof b.toppedUpBalance === "string" ? b.toppedUpBalance : null,
      remainingAmount: Number.isFinite(num) ? num : null,
    };
  });
}

/** 面向模型/终端的人类可读摘要（工具 render 使用；不包含任何密钥）。 */
export function summarizeResult(result) {
  const lines = [];
  const p = (result && result.providers) || {};
  const sub = (label, prov) => {
    if (!prov) return;
    if (prov.status !== "ok") {
      lines.push(`${label}: ${prov.status}${prov.error ? ` (${prov.error})` : ""}`);
      return;
    }
    const parts = (prov.windows || []).map(
      (w) =>
        `${w.name} 已用 ${w.usedPercent ?? "?"}%，剩余 ${w.remainingPercent ?? "?"}%` +
        (w.resetsAt ? `，${w.resetsAt} 重置` : ""),
    );
    lines.push(`${label}${prov.plan ? ` (${prov.plan})` : ""}: ${parts.join("；") || "无窗口数据"}`);
  };
  const bal = (label, prov) => {
    if (!prov) return;
    if (prov.status !== "ok") {
      lines.push(`${label}: ${prov.status}${prov.error ? ` (${prov.error})` : ""}`);
      return;
    }
    const parts = (prov.balances || []).map(
      (b) =>
        `${b.currency} ${b.totalBalance ?? "?"}（充值 ${b.toppedUpBalance ?? "?"} / 赠金 ${b.grantedBalance ?? "?"}）`,
    );
    lines.push(`${label}: ${parts.join("；") || "无余额数据"}`);
  };
  sub("Codex", p.codex);
  sub("Kimi", p.kimi);
  bal("DeepSeek", p.deepseek);
  sub("OpenCode Go", p.opencodeGo);
  return lines.join("\n");
}

export class AiQuotaGateway extends TypertRemoteService {
  static inject = ["tools"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, "aiQuota");
    this.config = config ?? {};

    const self = this;
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    ctx.tools.register(
      defineTool({
        name: "query_ai_quota",
        description:
          "Query the user's AI subscription balances and usage. Codex (rate-limit windows from the local codex CLI app-server), Kimi Code (quota windows via the CLI's OAuth login state), DeepSeek API balance, and OpenCode Go plan usage. Returns per-provider status, usage percentages, reset times, and balances. Never returns API keys. Providers with no key or missing CLI report a clear status instead of failing the whole query.",
        parameters: {
          providers: {
            type: "array",
            items: { type: "string", enum: ["codex", "kimi", "deepseek", "opencodeGo"] },
            description: "Optional: only query these providers. Defaults to all four.",
          },
        },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: summarizeResult(value) }],
        },
        timeoutMs: Math.max(timeoutMs * 2, 30000),
        async execute(args) {
          return self._queryAll(args && Array.isArray(args.providers) ? args.providers : null);
        },
      }),
    );
  }

  /** Remote method: result for the Settings page. filter 可选，只查指定 provider。 */
  async query(filter) {
    return this._queryAll(Array.isArray(filter) ? filter : null);
  }

  async _queryAll(filter) {
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const ALL = ["codex", "kimi", "deepseek", "opencodeGo"];
    const want = Array.isArray(filter)
      ? ALL.filter((name) => filter.includes(name))
      : ALL;
    const tasks = [];
    for (const name of want) {
      if (name === "codex") tasks.push(["codex", codexRateLimits(this.config.codexCli || DEFAULT_CODEX_CLI, timeoutMs)]);
      else if (name === "kimi") tasks.push(["kimi", queryKimi(this.ctx, this.config, timeoutMs)]);
      else if (name === "deepseek") tasks.push(["deepseek", queryDeepSeek(this.ctx, this.config, timeoutMs)]);
      else tasks.push(["opencodeGo", queryOpencodeGo(this.ctx, this.config, timeoutMs)]);
    }

    const settled = await Promise.allSettled(tasks.map(([, p]) => p));
    const providers = {};
    settled.forEach((outcome, i) => {
      const name = tasks[i][0];
      const value = outcome.status === "fulfilled" ? outcome.value : null;
      if (name === "codex") {
        const c = value ? normalizeCodex(value) : { status: "error", error: "internal", plan: null, windows: [] };
        providers.codex = {
          kind: "subscription",
          status: c.status,
          error: c.error,
          plan: c.plan,
          windows: toSubscriptionWindows(c.windows),
        };
      } else if (name === "kimi") {
        const k = value || { status: "error", error: "internal", keyConfigured: false, plan: null, windows: [] };
        providers.kimi = {
          kind: "subscription",
          status: k.status,
          keyConfigured: k.keyConfigured,
          error: k.error,
          plan: k.plan,
          windows: toSubscriptionWindows(k.windows),
        };
      } else if (name === "deepseek") {
        const d = value || { status: "error", error: "internal", keyConfigured: false, available: null, balances: [] };
        providers.deepseek = {
          kind: "balance",
          status: d.status,
          keyConfigured: d.keyConfigured,
          error: d.error,
          available: d.available,
          balances: toBalanceInfos(d.balances),
        };
      } else {
        const o = value || { status: "error", error: "internal", keyConfigured: false, windows: [] };
        providers.opencodeGo = {
          kind: "subscription",
          status: o.status,
          keyConfigured: o.keyConfigured,
          error: o.error,
          windows: toSubscriptionWindows(o.windows),
        };
      }
    });
    // 未请求的 provider 以 status: "skipped" 填充，保证结果形状完整
    // （Typert 边界校验要求所有 provider 键都存在）。
    for (const name of ALL) {
      if (providers[name] !== undefined) continue;
      if (name === "codex") providers.codex = { kind: "subscription", status: "skipped", error: null, plan: null, windows: [] };
      else if (name === "kimi") providers.kimi = { kind: "subscription", status: "skipped", keyConfigured: false, error: null, plan: null, windows: [] };
      else if (name === "deepseek") providers.deepseek = { kind: "balance", status: "skipped", keyConfigured: false, error: null, available: null, balances: [] };
      else providers.opencodeGo = { kind: "subscription", status: "skipped", keyConfigured: false, error: null, windows: [] };
    }
    return { fetchedAt: new Date().toISOString(), providers };
  }
}

// The loader applies a package's DEFAULT export as the plugin (function,
// class, or object with `apply`). The class is a Cordis Service plugin:
// cordis instantiates it with (ctx, config) after resolving `inject`.
export default AiQuotaGateway;
