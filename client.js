// Client half of the dsh-ai-quota plugin.
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
// It mounts the aiQuota Remote, registers a settings.section sidebar entry
// ("AI Quota"), and renders the unified-format usage page:
//   - subscription providers (Codex / OpenCode Go): one compact meter row per
//     quota window — label, slim usage bar, used %, relative reset time
//   - balance provider (DeepSeek): remaining amount + granted/topped-up split
window.__ModuleLoader__.load({
  id: "dsh-ai-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const NS = "settings.aiQuota";
    const inject = ["slots", "locale", "remote"];

    const zh = {
      nav: "AI 额度",
      title: "AI 额度",
      loading: "查询中…",
      refresh: "刷新",
      updatedAt: "更新于 {time}",
      unknown: "未知",
      providerCodex: "Codex",
      providerKimi: "Kimi",
      providerDeepseek: "DeepSeek",
      providerOpencodeGo: "OpenCode Go",
      statusNotConfigured: "未配置 API Key",
      statusNotInstalled: "未安装 codex CLI",
      statusError: "查询失败",
      noApiKeyDeepseek: "未找到 DeepSeek API Key（默认环境变量 DEEPSEEK_API_KEY，可在插件配置中改环境变量名）。",
      noApiKeyOpencode: "未找到 OpenCode Go API Key（默认环境变量 OPENCODE_GO_API_KEY，或 ~/.local/share/opencode/auth.json 的 opencode-go 条目）。",
      noCredentialsKimi: "未找到 Kimi 登录态（~/.kimi-code/credentials/kimi-code.json），请先运行 kimi login。",
      loginExpired: "Kimi 登录态已过期，请运行 kimi login 重新登录。",
      unauthorized: "API Key 无效或已过期（401）。",
      network: "网络请求失败，请稍后重试。",
      httpError: "接口返回 HTTP {status}。",
      remainingShort: "剩余",
      resetInMin: "{n} 分钟后重置",
      resetInHour: "{n} 小时后重置",
      resetInDay: "{n} 天后重置",
      resetPassed: "已到重置时间",
      chipRefresh: "点击刷新",
      noWindowData: "无窗口数据",
      noBalanceData: "无余额数据",
      window5h: "5 小时",
      window7d: "7 天",
      windowRolling: "滚动",
      windowWeekly: "每周",
      windowMonthly: "每月",
    };
    const en = {
      nav: "AI Quota",
      title: "AI Quota",
      loading: "Loading…",
      refresh: "Refresh",
      updatedAt: "Updated {time}",
      unknown: "unknown",
      providerCodex: "Codex",
      providerKimi: "Kimi",
      providerDeepseek: "DeepSeek",
      providerOpencodeGo: "OpenCode Go",
      statusNotConfigured: "API key not configured",
      statusNotInstalled: "codex CLI not installed",
      statusError: "Query failed",
      noApiKeyDeepseek: "No DeepSeek API key found (default env var DEEPSEEK_API_KEY; rename via plugin config).",
      noApiKeyOpencode: "No OpenCode Go API key found (default env var OPENCODE_GO_API_KEY, or the opencode-go entry in ~/.local/share/opencode/auth.json).",
      noCredentialsKimi: "No Kimi login state found (~/.kimi-code/credentials/kimi-code.json); run kimi login first.",
      loginExpired: "Kimi login expired; run kimi login to sign in again.",
      unauthorized: "API key is invalid or expired (401).",
      network: "Network request failed, try again later.",
      httpError: "HTTP {status} from the endpoint.",
      remainingShort: "left",
      resetInMin: "resets in {n} min",
      resetInHour: "resets in {n} h",
      resetInDay: "resets in {n} d",
      resetPassed: "reset time passed",
      noWindowData: "no window data",
      noBalanceData: "no balance data",
      window5h: "5h",
      window7d: "7d",
      windowRolling: "rolling",
      windowWeekly: "weekly",
      windowMonthly: "monthly",
      chipRefresh: "Click to refresh",
    };

    // Client-side Remote contribution. The result codec is a pass-through
    // parser: the Host already validates the business result against its own
    // zod schema before it crosses the wire.
    const TYPERT_REMOTE = {
      package: "dsh-ai-quota",
      descriptors: [
        {
          id: "dsh-ai-quota#aiQuota/query",
          service: "aiQuota",
          namespace: "aiQuota",
          method: "query",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "filter",
              wire: "filter",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-ai-quota#ProvidersFilter",
                schema: { parse(value) { return value; } },
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-ai-quota#AiQuotaResult",
            schema: { parse(value) { return value; } },
          },
        },
        {
          id: "dsh-ai-quota#aiQuota/refresh",
          service: "aiQuota",
          namespace: "aiQuota",
          method: "refresh",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "filter",
              wire: "filter",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-ai-quota#ProvidersFilter",
                schema: { parse(value) { return value; } },
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-ai-quota#AiQuotaResult",
            schema: { parse(value) { return value; } },
          },
        },
      ],
    };

    // ---- design tokens -------------------------------------------------
    // One slim list, hairline separators, no cards. Usage bars use a solid
    // severity color (emerald → amber → red) instead of a full-width
    // gradient: the color answers "should I worry" at a glance.
    const COLOR_OK = "#10b981";
    const COLOR_WARN = "#f59e0b";
    const COLOR_CRIT = "#ef4444";
    const MUTED = "var(--dsw-alias-label-tertiary)";
    const styles = {
      wrap: { maxWidth: 680, display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
      head: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "0 2px" },
      title: { fontSize: 16, fontWeight: 600, margin: 0, letterSpacing: "-.01em" },
      headRight: { display: "flex", alignItems: "center", gap: 8 },
      updated: { color: MUTED, fontSize: 13, margin: 0 },
      list: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "2px 16px", background: "var(--dsw-alias-bg-layer-3)" },
      provider: { padding: "12px 0", display: "flex", flexDirection: "column", gap: 8 },
      providerDivider: { borderTop: "1px solid var(--dsw-alias-border-l1)" },
      providerHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 },
      providerName: { fontSize: 14, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 7 },
      statusDot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block", flex: "none" },
      windowRow: { display: "grid", gridTemplateColumns: "minmax(40px, max-content) minmax(60px, 1fr) auto", alignItems: "center", gap: 12, minHeight: 20 },
      windowLabel: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      barTrack: { height: 5, borderRadius: 999, background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", boxSizing: "border-box", overflow: "hidden" },
      windowStat: { fontSize: 13, margin: 0, display: "flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" },
      windowPct: { fontWeight: 600, fontSize: 13, minWidth: 34, textAlign: "right", display: "inline-block" },
      windowReset: { color: MUTED },
      hint: { color: MUTED, fontSize: 13, lineHeight: 1.6, margin: 0 },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
      amount: { fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: "-.01em", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" },
      chipName: { color: "var(--dsw-alias-label-secondary)", fontWeight: 600 },
      chipValue: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      chipSeg: { display: "inline-flex", alignItems: "center", gap: 6 },
      chipSegLabel: { color: MUTED },
      chipSegReset: { color: MUTED },
      chipMiniTrack: { display: "inline-block", width: 44, height: 4, borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2)", boxSizing: "border-box", background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
      chipMiniFill: { display: "block", height: "100%", borderRadius: 999 },
      skelBar: { display: "inline-block", width: 44, height: 4, borderRadius: 999, background: "var(--dsw-alias-border-l2)" },
      skelText: { display: "inline-block", width: 68, height: 9, borderRadius: 5, background: "var(--dsw-alias-border-l2)" },
      skelName: { display: "inline-block", width: 36, height: 9, borderRadius: 5, background: "var(--dsw-alias-border-l2)" },
    };

    // Class-based bits (hover / spin) that inline styles cannot express.
    const STYLE_TAG_ID = "dsh-ai-quota-styles";
    function ensureStyleTag() {
      if (typeof document === "undefined" || document.getElementById(STYLE_TAG_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_TAG_ID;
      el.textContent = [
        ".dsh-ab-refresh{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;transition:background .15s ease,color .15s ease}",
        ".dsh-ab-refresh:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
        ".dsh-ab-refresh svg{display:block}",
        ".dsh-ab-refresh.spinning svg{animation:dsh-ab-spin .9s linear infinite}",
        "@keyframes dsh-ab-spin{to{transform:rotate(360deg)}}",
        ".dsh-ab-chip{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;line-height:20px;cursor:pointer;user-select:none;white-space:nowrap;padding:0 2px;border-radius:6px}",
        ".dsh-ab-chip:hover{background:var(--dsw-alias-bg-layer-1)}",
        ".dsh-ab-skel{animation:dsh-ab-pulse 1.3s ease-in-out infinite}",
        "@keyframes dsh-ab-pulse{0%,100%{opacity:.35}50%{opacity:.85}}",
        // Hero fallback placement: the hero composer is a flex column where the
        // token heatmap's root uses order:99 to drop below the input card. Our
        // chip span is a direct seat child (the seat is display:contents), so
        // order:50 lands it between card and heatmap, and align-self:center
        // keeps it on the card's horizontal center axis.
        '[data-slot="conversation.input.dock"]>.dsh-ab-chip{order:50;align-self:center}',
      ].join("\n");
      document.head.appendChild(el);
    }

    const RefreshIcon = () =>
      React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("polyline", { points: "23 4 23 10 17 10" }),
        React.createElement("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" })
      );

    /** Solid severity color for a used-percentage: green < 70 ≤ amber < 90 ≤ red. */
    function usageColor(used) {
      if (used === null) return COLOR_OK;
      if (used >= 90) return COLOR_CRIT;
      if (used >= 70) return COLOR_WARN;
      return COLOR_OK;
    }

    function fmtUpdatedAt(iso, t) {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return t("updatedAt").replace("{time}", d.toLocaleTimeString());
    }

    function fmtRelative(iso, t) {
      if (!iso) return t("unknown");
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const diffMs = d.getTime() - Date.now();
      if (diffMs <= 0) return t("resetPassed");
      const mins = Math.round(diffMs / 60000);
      if (mins < 60) return t("resetInMin").replace("{n}", String(mins));
      const hours = Math.round(mins / 60);
      if (hours < 24) return t("resetInHour").replace("{n}", String(hours));
      const days = Math.round(hours / 24);
      return t("resetInDay").replace("{n}", String(days));
    }

    function currencySymbol(currency) {
      const map = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };
      return map[currency] || (currency ? currency + " " : "");
    }

    function pct(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return Math.max(0, Math.min(100, value));
    }

    function errorText(value, t, name) {
      const e = value.error || "";
      if (value.status === "not-configured") {
        if (name === "deepseek") return t("noApiKeyDeepseek");
        if (name === "kimi") return e === "login-expired" ? t("loginExpired") : t("noCredentialsKimi");
        return t("noApiKeyOpencode");
      }
      if (e === "login-expired") return t("loginExpired");
      if (e === "unauthorized") return t("unauthorized");
      if (e === "network") return t("network");
      if (e.indexOf("http-") === 0) return t("httpError").replace("{status}", e.slice(5));
      return e ? t("statusError") + " (" + e + ")" : t("statusError");
    }

    // ---- subscription body: one compact meter row per quota window -----
    function windowLabel(name, t) {
      return name === "5h" ? t("window5h") : name === "7d" ? t("window7d") : name === "rolling" ? t("windowRolling") : name === "weekly" ? t("windowWeekly") : name === "monthly" ? t("windowMonthly") : name;
    }

    function WindowRow(props) {
      const { w, t } = props;
      const used = pct(w.usedPercent);
      const left = pct(w.remainingPercent);
      const color = usageColor(used);
      const label = windowLabel(w.name, t);
      const fill = {
        height: "100%",
        borderRadius: 999,
        width: (used === null ? 0 : used) + "%",
        background: color,
        transition: "width .25s ease",
      };
      const barTitle = left === null ? undefined : t("remainingShort") + " " + left + "%";
      return React.createElement("div", { style: styles.windowRow },
        React.createElement("span", { style: styles.windowLabel, title: label }, label),
        React.createElement("div", { style: styles.barTrack, title: barTitle },
          React.createElement("div", { style: fill })
        ),
        React.createElement("span", { style: styles.windowStat },
          React.createElement("b", { style: { ...styles.windowPct, color } }, used === null ? "—" : used + "%"),
          React.createElement("span", { style: styles.windowReset }, fmtRelative(w.resetsAt, t))
        )
      );
    }

    function SubscriptionBody(props) {
      const { value, t } = props;
      const windows = value.windows || [];
      if (windows.length === 0) {
        return React.createElement("p", { style: styles.hint }, t("noWindowData"));
      }
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
        windows.map((w, i) => React.createElement(WindowRow, { key: "w" + i, w, t }))
      );
    }

    // ---- balance body: just the remaining amount, nothing else --------
    function BalanceHead(props) {
      const { value } = props;
      const b = (value.balances || [])[0];
      if (!b || b.totalBalance === null || b.totalBalance === undefined) return null;
      return React.createElement("p", { style: styles.amount },
        React.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginRight: 2 } }, currencySymbol(b.currency)),
        b.totalBalance
      );
    }

    function BalanceBody(props) {
      const { value, t } = props;
      const b = (value.balances || [])[0];
      if (!b || b.totalBalance === null || b.totalBalance === undefined) {
        return React.createElement("p", { style: styles.hint }, t("noBalanceData"));
      }
      return null; // the amount in the header says it all
    }

    // ---- provider block: name (+status dot only when abnormal), body ---
    function ProviderBlock(props) {
      const { name, title, value, t, headExtra, divider, children } = props;
      const ok = value.status === "ok";
      let body;
      if (value.status === "loading" || value.status === "skipped") {
        body = React.createElement("p", { style: styles.hint }, t("loading"));
      } else if (ok) {
        body = children;
      } else if (value.status === "not-configured" || value.status === "not-installed") {
        body = React.createElement("p", { style: styles.hint }, errorText(value, t, name));
      } else {
        body = React.createElement("p", { style: styles.error }, errorText(value, t, name));
      }
      const dotColor = value.status === "error" ? "var(--dsw-alias-state-error-primary)" : MUTED;
      return React.createElement("section", { style: { ...styles.provider, ...(divider ? styles.providerDivider : {}) } },
        React.createElement("header", { style: styles.providerHead },
          React.createElement("h3", { style: styles.providerName },
            ok ? null : React.createElement("span", { style: { ...styles.statusDot, background: dotColor } }),
            title
          ),
          headExtra || null
        ),
        body
      );
    }

    // ---- cache + per-provider independent loading ----
    const CACHE_KEY = "dsh-ai-quota.cache.v1";
    const PROVIDER_NAMES = ["codex", "kimi", "opencodeGo", "deepseek"];

    function loadCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.fetchedAt && parsed.providers && typeof parsed.providers === "object") {
          return parsed;
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    function saveCache(value) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }

    // ---- composer balance chip -----------------------------------------
    // A minimal readout under the input box: current model → provider → its
    // quota windows. Fixed seat: conversation.composer.dock (below the input
    // card, next to the shipped stats line); on the new-chat hero — which has
    // no composer.dock seat — it falls back to conversation.input.dock,
    // stacked above the token heatmap.

    // The composer quota chip is always on: no user switch exists, and no
    // persisted off-state can hide it from the new-chat page.
    const CHIP_SEATS = [
      ["above", "conversation.input.dock", 5],
      ["below", "conversation.composer.dock", 30],
    ];
    const CHIP_TTL_MS = 10 * 60 * 1000;
    const CHIP_MIN_ATTEMPT_MS = 60 * 1000;

    /** Heuristic: DSH model selection (provider route + model id) → our provider. */
    function mapModelToProvider(provider, model) {
      const s = ((provider || "") + "/" + (model || "")).toLowerCase();
      if (s.indexOf("kimi") >= 0 || s.indexOf("moonshot") >= 0) return "kimi";
      if (s.indexOf("codex") >= 0 || s.indexOf("openai") >= 0 || s.indexOf("gpt") >= 0) return "codex";
      if (s.indexOf("deepseek") >= 0) return "deepseek";
      if (s.indexOf("opencode") >= 0) return "opencodeGo";
      return null;
    }

    // Chip data: provider → { value, at, status }. Seeded from the shared page
    // cache; fresh results are written back to it so both surfaces stay
    // consistent. status: "ready" | "loading" | "error" — stale data stays
    // visible while a refresh is in flight (no disappear-then-appear).
    const chipState = (() => {
      const cached = loadCache();
      const state = {};
      if (cached) {
        const at = Date.parse(cached.fetchedAt) || 0;
        for (const name of PROVIDER_NAMES) {
          const prov = cached.providers[name];
          if (prov) state[name] = { value: prov, at, status: "ready" };
        }
      }
      return state;
    })();
    const chipListeners = new Set();
    const chipAttempts = new Map();
    function subscribeChipStore(fn) {
      chipListeners.add(fn);
      return () => chipListeners.delete(fn);
    }
    function chipSet(provider, record) {
      chipState[provider] = record;
      chipListeners.forEach((f) => f());
    }
    function chipEnsure(query, refresh, provider, force) {
      const now = Date.now();
      const cur = chipState[provider];
      if (!force && cur && cur.at > 0 && now - cur.at < CHIP_TTL_MS) return;
      const lastTry = chipAttempts.get(provider) || 0;
      if (!force && now - lastTry < CHIP_MIN_ATTEMPT_MS) return;
      chipAttempts.set(provider, now);
      chipSet(provider, { value: cur && cur.value ? cur.value : null, at: cur ? cur.at : 0, status: "loading" });
      Promise.resolve()
        .then(() => (force ? refresh : query)([provider]))
        .then((result) => {
          if (!result || result.ok === false) throw new Error("remote failed");
          const prov = result.value && result.value.providers && result.value.providers[provider];
          if (!prov || prov.status === "skipped") throw new Error("skipped");
          chipSet(provider, { value: prov, at: Date.now(), status: "ready" });
          const cached = loadCache();
          saveCache({
            fetchedAt: new Date().toISOString(),
            providers: { ...(cached ? cached.providers : {}), [provider]: prov },
          });
        })
        .catch(() => {
          const c = chipState[provider];
          chipSet(provider, { value: c && c.value ? c.value : null, at: c ? c.at : 0, status: "error" });
        });
    }

    /** The hero (new-chat) composer has no composer.dock seat — detect it. */
    function composerDockPresent() {
      try {
        return !!document.querySelector('[data-slot="conversation.composer.dock"]');
      } catch {
        return false;
      }
    }

    /** Pulsing placeholder that reserves the chip's layout while loading. */
    function ChipSkeleton(props) {
      const { name } = props;
      return React.createElement("span", { className: "dsh-ab-chip", "aria-hidden": "true" },
        name
          ? React.createElement("span", { style: styles.chipName }, name)
          : React.createElement("span", { className: "dsh-ab-skel", style: styles.skelName }),
        [0, 1].map((i) =>
          React.createElement("span", { key: "sk" + i, style: { ...styles.chipSeg, marginLeft: i === 0 ? 4 : 12 } },
            React.createElement("span", { className: "dsh-ab-skel", style: styles.skelBar }),
            React.createElement("span", { className: "dsh-ab-skel", style: styles.skelText })
          )
        )
      );
    }

    function BalanceChip(props) {
      const { seat, available, directory, load, query, refresh, t } = props;
      const subscribeDirectory = React.useCallback(
        (cb) => (directory ? directory.subscribe(cb) : () => {}),
        [directory]
      );
      const dirState = React.useSyncExternalStore(
        subscribeDirectory,
        () => (directory ? directory.getSnapshot() : null)
      );
      React.useEffect(() => { if (available && load) load(); }, [available, load]);
      const current = dirState ? dirState.current : null;
      const dirLoading = !!dirState && (dirState.status === "idle" || dirState.status === "loading");
      const provider = available && current ? mapModelToProvider(current.provider, current.model) : null;
      React.useEffect(() => { if (provider) chipEnsure(query, refresh, provider, false); }, [provider, query, refresh]);
      const record = React.useSyncExternalStore(
        subscribeChipStore,
        () => (provider ? chipState[provider] || null : null)
      );

      // Hero fallback: the input.dock instance renders only when the page has
      // no composer.dock seat (the new-chat hero); dockPresent stays null
      // until measured, so a conversation never flashes it for a frame.
      const [dockPresent, setDockPresent] = React.useState(null);
      React.useEffect(() => {
        if (seat !== "above") return;
        const check = () => setDockPresent(composerDockPresent());
        check();
        const mo = new MutationObserver(check);
        mo.observe(document.body, { childList: true, subtree: true });
        return () => mo.disconnect();
      }, [seat]);

      const visible = seat === "below" || dockPresent === false;
      if (!visible || !available) return null;

      const name = provider ? t("provider" + provider.charAt(0).toUpperCase() + provider.slice(1)) : null;
      const value = record && record.value && record.value.status === "ok" ? record.value : null;
      const refreshing = !!record && record.status === "loading" && !!value;

      if (!value) {
        if ((!provider && dirLoading) || (provider && (!record || record.status === "loading"))) {
          return React.createElement(ChipSkeleton, { name });
        }
        return null; // unmapped model / failed query: stay out of the way
      }

      const isBalance = value.kind === "balance" || value.balances !== undefined;
      const onRefresh = () => chipEnsure(query, refresh, provider, true);
      const chipClass = "dsh-ab-chip" + (refreshing ? " dsh-ab-skel" : "");

      if (isBalance) {
        const b = (value.balances || [])[0];
        if (!b || b.totalBalance == null) return null;
        return React.createElement("span", {
          className: chipClass,
          title: t("chipRefresh"),
          onClick: onRefresh,
        },
          React.createElement("span", { style: styles.chipName }, name),
          React.createElement("b", { style: styles.chipValue }, currencySymbol(b.currency) + b.totalBalance)
        );
      }
      const windows = (value.windows || []).filter(Boolean);
      if (windows.length === 0) return null;
      return React.createElement("span", {
        className: chipClass,
        title: t("chipRefresh"),
        onClick: onRefresh,
      },
        React.createElement("span", { style: styles.chipName }, name),
        windows.map((w, i) => {
          const used = pct(w.usedPercent);
          const color = usageColor(used);
          return React.createElement("span", { key: "seg" + i, style: { ...styles.chipSeg, marginLeft: i === 0 ? 4 : 12 } },
            React.createElement("span", { style: styles.chipSegLabel }, windowLabel(w.name, t)),
            React.createElement("span", { style: styles.chipMiniTrack },
              React.createElement("span", { style: { ...styles.chipMiniFill, width: (used === null ? 0 : used) + "%", background: color } })
            ),
            React.createElement("b", { style: { ...styles.chipValue, color } }, used === null ? "—" : used + "%"),
            React.createElement("span", { style: styles.chipSegReset }, fmtRelative(w.resetsAt, t))
          );
        })
      );
    }

    function BalancesPanel(props) {
      const { query, refresh, t } = props;
      const [cards, setCards] = React.useState(() => {
        const cached = loadCache();
        const providers = {};
        const state = {};
        for (const name of PROVIDER_NAMES) {
          providers[name] = cached ? cached.providers[name] : null;
          state[name] = "loading";
        }
        return {
          providers,
          fetchedAt: cached ? cached.fetchedAt : null,
          state,
          errors: {},
        };
      });
      const mounted = React.useRef(true);
      React.useEffect(() => () => { mounted.current = false; }, []);

      const refreshOne = React.useCallback((name, force) => {
        setCards((s) => ({ ...s, state: { ...s.state, [name]: "loading" }, errors: { ...s.errors, [name]: null } }));
        Promise.resolve()
          .then(() => (force ? refresh : query)([name]))
          .then((result) => {
            if (!result || result.ok === false) {
              throw new Error((result && result.error && result.error.message) || "remote failed");
            }
            const prov = result.value && result.value.providers && result.value.providers[name];
            if (!prov || prov.status === "skipped" || !mounted.current) return;
            setCards((s) => {
              const providers = { ...s.providers, [name]: prov };
              const fetchedAt = (result.value && result.value.fetchedAt) || s.fetchedAt;
              saveCache({ fetchedAt, providers });
              return { ...s, providers, fetchedAt, state: { ...s.state, [name]: "done" } };
            });
          })
          .catch((e) => {
            if (!mounted.current) return;
            setCards((s) => ({
              ...s,
              state: { ...s.state, [name]: "error" },
              errors: { ...s.errors, [name]: String((e && e.message) || e) },
            }));
          });
      }, [query, refresh]);

      // 挂载走缓存（host 调度器保鲜）；刷新按钮强制现场查询。
      const refreshAll = React.useCallback((force) => {
        for (const name of PROVIDER_NAMES) refreshOne(name, force);
      }, [refreshOne]);

      React.useEffect(() => { refreshAll(false); }, [refreshAll]);

      const refreshingAny = PROVIDER_NAMES.some((n) => cards.state[n] === "loading");

      const renderProvider = (name, headExtra, body, divider) => {
        const st = cards.state[name];
        const prov = cards.providers[name];
        const value = st === "error"
          ? { status: "error", error: cards.errors[name] || "unknown" }
          : prov || { status: st === "loading" ? "loading" : "skipped" };
        const titleKey = "provider" + name.charAt(0).toUpperCase() + name.slice(1);
        return React.createElement(ProviderBlock, { key: name, name, title: t(titleKey), value, t, headExtra, divider }, body);
      };

      const updated = fmtUpdatedAt(cards.fetchedAt, t);
      return React.createElement("div", { style: styles.wrap },
        React.createElement("div", { style: styles.head },
          React.createElement("h2", { style: styles.title }, t("title")),
          React.createElement("div", { style: styles.headRight },
            updated ? React.createElement("p", { style: styles.updated }, updated) : null,
            React.createElement("button", {
              className: "dsh-ab-refresh" + (refreshingAny ? " spinning" : ""),
              onClick: () => refreshAll(true),
              title: t("refresh"),
              "aria-label": t("refresh"),
            }, React.createElement(RefreshIcon))
          )
        ),
        React.createElement("div", { style: styles.list },
          renderProvider("codex", null, React.createElement(SubscriptionBody, { value: cards.providers.codex || {}, t }), false),
          renderProvider("kimi", null, React.createElement(SubscriptionBody, { value: cards.providers.kimi || {}, t }), true),
          renderProvider("opencodeGo", null, React.createElement(SubscriptionBody, { value: cards.providers.opencodeGo || {}, t }), true),
          renderProvider("deepseek", React.createElement(BalanceHead, { value: cards.providers.deepseek || {}, t }), React.createElement(BalanceBody, { value: cards.providers.deepseek || {}, t }), true)
        )
      );
    }

    function apply(ctx) {
      const mountReady = ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-ai-quota: dictionaries");
      ctx.effect(ensureStyleTag, "dsh-ai-quota: styles");
      const t = ctx.locale.bind(NS);

      const callRemote = (method, filter) => {
        return Promise.resolve(mountReady).then(async () => {
          const api = ctx.get("remote.aiQuota");
          if (!api) throw new Error("aiQuota remote is unavailable");
          return api[method](filter);
        });
      };
      // query 读 host 缓存（调度器每 2 分钟保鲜）；refresh 强制现场查询，
      // 只用于用户手动触发的刷新。
      const query = (filter) => callRemote("query", filter);
      const refresh = (filter) => callRemote("refresh", filter);
      const injected = () => ({ query, refresh, t });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "ai-quota",
        order: 41,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      }, BalancesPanel));

      // Composer chip: register into every candidate seat; the component
      // renders only in the selected one. Runs in its own dependent fiber so
      // a missing model-selection service never blocks the settings page.
      ctx.inject(["slots", "modelDirectories", "sessions"], (scope) => {
        const models = scope.modelDirectories || scope.get("modelDirectories");
        const sessions = scope.sessions;
        for (const [posKey, seat, seatOrder] of CHIP_SEATS) {
          scope.slots.inject(seat, () => scope.slots.register({
            name: seat,
            id: "ai-quota-chip",
            order: seatOrder,
            locale: NS,
            inject: (sessionId) => {
              let directory = null;
              let available = false;
              try {
                available = sessions.subagentAddress(sessionId) === void 0;
                if (available) directory = models.directoryFor(sessionId);
              } catch {
                directory = null;
                available = false;
              }
              return {
                seat: posKey,
                available,
                directory: directory ? directory.store : null,
                load: () => {
                  if (available && directory) directory.load().catch(() => {});
                },
                query,
                refresh,
                t,
              };
            },
          }, BalanceChip));
        }
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
