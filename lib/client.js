window.__ModuleLoader__.load({
  id: "dsh-fans-session-recycle/client",
  factory: (require) => {
    const exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const name = "session-recycle/client";
    const inject = ["slots", "contextMenus", "workspaces", "sessions"];

    const STORAGE_KEY = "dsh-plugin-session-recycle:state:v1";
    const LEGACY_KEY = "dsh-plugin-busy-workspace:recycle:v1";
    const WORKSPACE_STATE_KEY = "dsh-plugin-busy-workspace:state:v2";
    const OVERVIEW_SCENE_KEY = "dsh-session-overview.scene.v1";
    const RECYCLED_ATTR = "data-session-recycle";
    const ROUTE = "/session-recycle/recycle-bin";
    const STYLE_ID = "dsh-session-recycle-style";
    const BUNDLE_NAME = "dsh-fans-session-recycle";
    const SETTINGS_KEY = "dsh-plugin-session-recycle:settings:v1";

    const DEFAULT_SETTINGS = {
      summaryCollapsed: true,
      summaryPrompts: 5,
      summaryResponses: 3,
      maxEntries: 200,
      autoPrune: true,
    };

    const NUMERIC_LIMITS = {
      // Host 最多返回 6 条 prompt，其中第 1 条已作为「任务」行展示，
      // 过程行可用上限是 5；再大就是死值。
      summaryPrompts: { min: 0, max: 5 },
      summaryResponses: { min: 0, max: 3 },
      maxEntries: { min: 10, max: 1000 },
    };

    function mergeSettings(raw) {
      if (raw === null || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
      const out = { ...DEFAULT_SETTINGS };
      for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        const value = raw[key];
        const limits = NUMERIC_LIMITS[key];
        if (limits !== undefined) {
          if (typeof value === "number" && Number.isFinite(value)) {
            out[key] = Math.min(limits.max, Math.max(limits.min, Math.round(value)));
          }
        } else if (typeof value === "boolean") {
          out[key] = value;
        }
      }
      return out;
    }

    function loadSettings() {
      try {
        const text = window.localStorage.getItem(SETTINGS_KEY);
        return text === null ? { ...DEFAULT_SETTINGS } : mergeSettings(JSON.parse(text));
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    }

    let currentSettings = null;
    const settingsListeners = new Set();

    function getSettings() {
      if (currentSettings === null) currentSettings = loadSettings();
      return currentSettings;
    }

    function emitSettings() {
      for (const listener of [...settingsListeners]) {
        try {
          listener(currentSettings);
        } catch {
          /* a listener must not break the settings write */
        }
      }
    }

    function saveSettings(patch) {
      currentSettings = mergeSettings({ ...getSettings(), ...patch });
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
      } catch {
        /* a full or disabled storage must not break the page */
      }
      emitSettings();
      return currentSettings;
    }

    function resetSettings() {
      currentSettings = { ...DEFAULT_SETTINGS };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
      } catch {
        /* ignore */
      }
      emitSettings();
      return currentSettings;
    }

    function subscribeSettings(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    }

    function useSettings() {
      const [value, setValue] = React.useState(getSettings);
      React.useEffect(() => subscribeSettings(() => setValue(getSettings())), []);
      return value;
    }

    function serviceOf(ctx, key) {
      try {
        return ctx.get(key);
      } catch {
        return undefined;
      }
    }

    function snapshotOf(store) {
      try {
        return store?.getSnapshot?.();
      } catch {
        return undefined;
      }
    }

    function toArray(value) {
      if (Array.isArray(value)) return value;
      if (value !== null && value !== undefined && typeof value[Symbol.iterator] === "function") {
        return [...value];
      }
      return [];
    }

    function setAttr(node, name, value) {
      if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }

    function dropAttr(node, name) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    }

    function sessionIdOf(row) {
      const key = row.getAttribute("data-row-key") ?? "";
      return key.startsWith("session:") ? key.slice("session:".length) : null;
    }

    function sessionIdVariants(id) {
      return id.startsWith("session-") ? [id, id.slice("session-".length)] : [id, `session-${id}`];
    }

    const css = `
[class*="_sessionRow"][data-session-recycle="true"] {
  display: none !important;
}

.bw-recycle-menu button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.bw-recycle-expand:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
`;

    function insertStyle() {
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) existing.remove();
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
      return () => style.remove();
    }

    // ── Recycle state ────────────────────────────────────────────────
    const recycleListeners = new Set();
    let recycleState = null;
    let scheduled = false;
    let disposed = false;
    let observer = null;
    let tick = null;
    let startupPruneAt = 0;
    const purgedSessionIds = new Set();

    function emptyState() {
      return { version: 1, sessions: {} };
    }

    function normalizeState(input) {
      if (input === null || typeof input !== "object" || input.version !== 1) return emptyState();
      const sessions = {};
      for (const [id, entry] of Object.entries(input.sessions ?? {})) {
        if (typeof id !== "string" || id === "") continue;
        if (entry === null || typeof entry !== "object") continue;
        sessions[id] = { deletedAt: Number(entry.deletedAt) || Date.now() };
      }
      return { version: 1, sessions };
    }

    function loadRecycleState() {
      try {
        let raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) {
          const legacy = window.localStorage.getItem(LEGACY_KEY);
          if (legacy !== null) {
            raw = legacy;
            window.localStorage.removeItem(LEGACY_KEY);
          }
        }
        if (raw === null) return emptyState();
        const state = normalizeState(JSON.parse(raw));
        const maxEntries = getSettings().maxEntries;
        const ids = Object.keys(state.sessions);
        if (ids.length > maxEntries) {
          ids.sort((a, b) => (state.sessions[a].deletedAt || 0) - (state.sessions[b].deletedAt || 0));
          for (const oldest of ids.slice(0, ids.length - maxEntries)) delete state.sessions[oldest];
        }
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        return state;
      } catch {
        return emptyState();
      }
    }

    function getRecycleState() {
      if (recycleState === null) recycleState = loadRecycleState();
      return recycleState;
    }

    function persistRecycle() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getRecycleState()));
      } catch {
        /* the panel still works in memory */
      }
    }

    function notifyRecycle() {
      for (const listener of [...recycleListeners]) {
        try {
          listener();
        } catch {
          /* ignore */
        }
      }
    }

    function subscribeRecycle(listener) {
      recycleListeners.add(listener);
      return () => recycleListeners.delete(listener);
    }

    /**
     * 按当前 maxEntries 裁剪记录（保留最近删除的）。
     * 保存配置、添加记录、面板挂载都走这里，保证「保存即生效」，
     * 不再依赖面板是否已被打开。
     * @returns 是否真的删掉了记录
     */
    function trimToMaxEntries() {
      const state = getRecycleState();
      const maxEntries = getSettings().maxEntries;
      const ids = Object.keys(state.sessions);
      if (ids.length <= maxEntries) return false;
      ids.sort((a, b) => (state.sessions[a].deletedAt || 0) - (state.sessions[b].deletedAt || 0));
      for (const oldest of ids.slice(0, ids.length - maxEntries)) delete state.sessions[oldest];
      persistRecycle();
      return true;
    }

    function isRecycled(id) {
      const state = getRecycleState();
      return sessionIdVariants(id).some((variant) => state.sessions[variant] !== undefined);
    }

    function recycleAdd(id) {
      const state = getRecycleState();
      if (state.sessions[id] !== undefined) return;
      state.sessions[id] = { deletedAt: Date.now() };
      trimToMaxEntries();
      persistRecycle();
      notifyRecycle();
      schedulePaint();
    }

    function recycleRemove(id) {
      const state = getRecycleState();
      if (state.sessions[id] === undefined) return;
      delete state.sessions[id];
      persistRecycle();
      notifyRecycle();
      schedulePaint();
    }

    function purgeOverviewScene(id) {
      try {
        const raw = window.localStorage.getItem(OVERVIEW_SCENE_KEY);
        if (raw === null) return;
        const scene = JSON.parse(raw);
        if (scene === null || typeof scene !== "object" || scene.sessions === null || typeof scene.sessions !== "object") return;
        let changed = false;
        for (const variant of sessionIdVariants(id)) {
          if (!Object.prototype.hasOwnProperty.call(scene.sessions, variant)) continue;
          delete scene.sessions[variant];
          changed = true;
        }
        if (changed) window.localStorage.setItem(OVERVIEW_SCENE_KEY, JSON.stringify(scene));
      } catch {
        /* optional presentation cache */
      }
    }

    function purgeWorkspaceState(id) {
      try {
        const raw = window.localStorage.getItem(WORKSPACE_STATE_KEY);
        if (raw === null) return;
        const state = JSON.parse(raw);
        if (state === null || typeof state !== "object" || state.sessions === null || typeof state.sessions !== "object") return;
        let changed = false;
        for (const variant of sessionIdVariants(id)) {
          if (!Object.prototype.hasOwnProperty.call(state.sessions, variant)) continue;
          delete state.sessions[variant];
          changed = true;
        }
        if (changed) window.localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(state));
      } catch {
        /* the sorting plugin also prunes stale entries */
      }
    }

    // ── Host capability + summary/purge ───────────────────────────────
    let recycleCapability = "";
    let recycleCapabilityPromise = null;

    function newRecycleCapability() {
      const cryptoApi = globalThis.crypto;
      if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
      const bytes = new Uint8Array(24);
      if (cryptoApi?.getRandomValues !== undefined) cryptoApi.getRandomValues(bytes);
      else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
      return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function ensureRecycleCapability(force = false) {
      if (force) {
        recycleCapability = "";
        recycleCapabilityPromise = null;
      }
      if (recycleCapability !== "") return recycleCapability;
      if (recycleCapabilityPromise !== null) return recycleCapabilityPromise;
      const token = newRecycleCapability();
      recycleCapabilityPromise = (async () => {
        const response = await fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "register", token }),
        });
        if (!response.ok) throw new Error("无法初始化回收站安全令牌");
        recycleCapability = token;
        return token;
      })().finally(() => {
        recycleCapabilityPromise = null;
      });
      return recycleCapabilityPromise;
    }

    async function postRecycle(payload) {
      let token = await ensureRecycleCapability();
      let response = await fetch(ROUTE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-recycle-token": token,
        },
        body: JSON.stringify({ ...payload, token }),
      });
      if (response.status === 403) {
        token = await ensureRecycleCapability(true);
        response = await fetch(ROUTE, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-recycle-token": token,
          },
          body: JSON.stringify({ ...payload, token }),
        });
      }
      return response;
    }

    async function purgeRecycled(id) {
      let response;
      try {
        response = await postRecycle({ action: "purge", sessionId: id });
      } catch {
        throw new Error("无法连接本机 DSH Host，彻底删除未执行");
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(
          response.status === 403
            ? "删除令牌已失效，请刷新客户端窗口后再试"
            : payload?.message ?? `彻底删除失败（HTTP ${response.status}）`,
        );
      }
      purgedSessionIds.add(id);
      purgeWorkspaceState(id);
      purgeOverviewScene(id);
      try {
        window.dispatchEvent(new CustomEvent("dsh-busy-workspace:purged", { detail: { id } }));
      } catch {
        /* the sorting plugin may not be loaded */
      }
      recycleRemove(id);
      schedulePaint();
      return payload;
    }

    // ── Row hiding / pruning ─────────────────────────────────────────
    function pruneRecycle(archived, sessions) {
      if (!getSettings().autoPrune) return;
      if (Date.now() < startupPruneAt) return;
      if (archived.size === 0) return;
      const state = getRecycleState();
      let changed = false;
      for (const id of Object.keys(state.sessions)) {
        if (sessions.get(id) === undefined) continue;
        if (!archived.has(id)) {
          delete state.sessions[id];
          changed = true;
        }
      }
      if (changed) {
        persistRecycle();
        notifyRecycle();
      }
    }

    function paint() {
      if (disposed) return;
      const sessionsService = serviceOf(registerCtx, "sessions");
      const workspacesService = serviceOf(registerCtx, "workspaces");
      const sessionSnapshot = snapshotOf(sessionsService?.list);
      const workspaceSnapshot = snapshotOf(workspacesService?.list);
      const archived = new Set(workspaceSnapshot?.archivedSessionIds ?? []);
      const sessions = sessionSnapshot?.byId ?? {};
      pruneRecycle(archived, new Map(Object.entries(sessions)));
      const state = getRecycleState();
      for (const row of document.querySelectorAll('[class*="_sessionRow"]')) {
        const id = sessionIdOf(row);
        const variants = id === null ? [] : sessionIdVariants(id);
        const recycled = variants.some((variant) => state.sessions[variant] !== undefined || purgedSessionIds.has(variant));
        setAttr(row, RECYCLED_ATTR, recycled ? "true" : "false");
      }
    }

    function schedulePaint() {
      if (disposed || scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        paint();
      });
    }

    let registerCtx = null;

    // 展开态判定：默认展开时「不在集合里」才是展开，默认折叠时反之。
    // 两个纯函数都放在面板外，便于测试同时覆盖两种默认模式。
    function summaryExpanded(expanded, id, defaultExpanded) {
      return defaultExpanded ? !expanded.has(id) : expanded.has(id);
    }

    // 两态互斥翻转：无论默认展开还是默认折叠，切换成员都能翻转折开状态。
    function toggleMembership(expanded, id) {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }

    function RecyclePanel({ ctx }) {
      const [, force] = React.useState(0);
      const [menu, setMenu] = React.useState(null);
      const [confirm, setConfirm] = React.useState(null);
      const [purging, setPurging] = React.useState(false);
      const [purgeError, setPurgeError] = React.useState("");
      const [summaries, setSummaries] = React.useState({});
      const [summaryState, setSummaryState] = React.useState("idle");
      const [expandedSummaries, setExpandedSummaries] = React.useState(() => new Set());
      const [purgeNotice, setPurgeNotice] = React.useState("");
      const settings = useSettings();
      const defaultExpanded = settings.summaryCollapsed === false;
      const isExpanded = (id) => summaryExpanded(expandedSummaries, id, defaultExpanded);

      React.useEffect(() => {
        // 面板挂载时兜底再裁一次；正常路径由 register 里的设置订阅在保存时就裁好。
        if (trimToMaxEntries()) notifyRecycle();
      }, [settings.maxEntries]);

      React.useEffect(() => {
        const sessionsService = serviceOf(ctx, "sessions");
        const workspacesService = serviceOf(ctx, "workspaces");
        const stores = [sessionsService?.list, workspacesService?.list].filter(
          (store) => store !== undefined && store !== null && typeof store.subscribe === "function",
        );
        const disposers = [];
        for (const store of stores) {
          try {
            disposers.push(store.subscribe(() => force((value) => value + 1)));
          } catch {
            /* the panel still refreshes on its own actions */
          }
        }
        const off = subscribeRecycle(() => force((value) => value + 1));
        return () => {
          off();
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
        };
      }, [ctx]);

      React.useEffect(() => {
        if (menu === null) return;
        const close = () => setMenu(null);
        const onKey = (event) => {
          if (event.key === "Escape") close();
        };
        document.addEventListener("click", close);
        document.addEventListener("contextmenu", close);
        document.addEventListener("keydown", onKey);
        window.addEventListener("scroll", close, true);
        return () => {
          document.removeEventListener("click", close);
          document.removeEventListener("contextmenu", close);
          document.removeEventListener("keydown", onKey);
          window.removeEventListener("scroll", close, true);
        };
      }, [menu]);

      const sessionsService = serviceOf(ctx, "sessions");
      const workspacesService = serviceOf(ctx, "workspaces");
      const sessionSnapshot = snapshotOf(sessionsService?.list) ?? { byId: {} };
      const workspaceSnapshot = snapshotOf(workspacesService?.list) ?? { items: [], archivedSessionIds: [] };
      const archived = new Set(workspaceSnapshot.archivedSessionIds ?? []);
      const recycle = getRecycleState().sessions;
      const workspaceName = new Map();
      for (const workspace of toArray(workspaceSnapshot.items)) {
        const label = workspace.title || "工作区";
        for (const id of workspace.sessionIds ?? []) workspaceName.set(id, label);
      }

      const rows = [];
      for (const [id, entry] of Object.entries(recycle)) {
        if (!sessionIdVariants(id).some((variant) => archived.has(variant))) continue;
        const session = sessionSnapshot.byId?.[id] ?? sessionSnapshot.byId?.[sessionIdVariants(id).find((variant) => sessionSnapshot.byId?.[variant] !== undefined)];
        if (session === null || session === undefined || session.blank) continue;
        if (session.origin === "subagent") continue;
        rows.push({
          id,
          title: (session.title || "").trim() || "未命名会话",
          workspace: workspaceName.get(id) || "未分组",
          deletedAt: entry.deletedAt || 0,
          updatedAt: session.updatedAt || 0,
        });
      }
      rows.sort((a, b) => b.deletedAt - a.deletedAt);
      const summaryKey = rows.map((row) => row.id).join("|");

      React.useEffect(() => {
        if (rows.length === 0) {
          setSummaries({});
          setSummaryState("idle");
          return;
        }
        let cancelled = false;
        setSummaryState("loading");
        postRecycle({ action: "summaries", sessionIds: rows.map((row) => row.id) })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (cancelled) return;
            if (payload?.ok === true && payload.summaries !== undefined) {
              setSummaries(payload.summaries);
              setSummaryState("ready");
            } else {
              setSummaryState("error");
            }
          })
          .catch(() => {
            if (!cancelled) setSummaryState("error");
          });
        return () => {
          cancelled = true;
        };
      }, [summaryKey]);

      const formatWhen = (value) => {
        const ms = Number(value) || 0;
        if (ms === 0) return "";
        try {
          return new Date(ms).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch {
          return "";
        }
      };

      const summaryLine = (label, text, clampLines = 3) =>
        h(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "flex-start" } },
          h("span", { style: summaryLabelStyle }, label),
          h(
            "span",
            {
              style: {
                ...summaryValueStyle,
                display: "-webkit-box",
                WebkitLineClamp: clampLines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              },
            },
            text,
          ),
        );

      const renderSummary = (row) => {
        const summary = summaries[row.id];
        if (summary === undefined || summary === null) {
          const message =
            summaryState === "loading"
              ? "正在读取历史摘要…"
              : summaryState === "error"
                ? "历史摘要读取失败"
                : summaryState === "unavailable"
                  ? "历史摘要暂不可用"
                  : "（没有可用的历史摘要）";
          return h("div", { style: summaryStyle }, h("div", { style: summaryValueStyle }, message));
        }
        const prompts = Array.isArray(summary.prompts)
          ? summary.prompts.filter((prompt) => typeof prompt === "string" && prompt.trim() !== "")
          : [];
        const first = (summary.firstPrompt || prompts[0] || "").trim();
        const rest =
          settings.summaryPrompts > 0
            ? prompts.filter((prompt) => prompt.trim() !== first).slice(-settings.summaryPrompts)
            : [];
        const last = (summary.lastPrompt || "").trim();
        const lastClean = last.replace(/…$/, "").trim();
        const lastIsPrefix = lastClean !== "" && (first.startsWith(lastClean) || lastClean.startsWith(first.slice(0, 50)));
        const responses = Array.isArray(summary.responses)
          ? summary.responses.filter((text) => typeof text === "string" && text.trim() !== "")
          : [];
        const result =
          settings.summaryResponses <= 0
            ? ""
            : responses.length > 0
              ? responses.slice(-settings.summaryResponses).join("　·　")
              : (summary.lastResponse || "").trim();
        const lines = [];
        if (first !== "") lines.push(summaryLine("任务", first, 4));
        if (rest.length > 0) lines.push(summaryLine("过程", rest.join("　·　"), 2));
        if (last !== "" && last !== first && !lastIsPrefix && !rest.includes(last)) lines.push(summaryLine("最近", last, 2));
        if (result !== "") lines.push(summaryLine("结果", result, 4));
        const when = formatWhen(row.updatedAt);
        lines.push(
          h(
            "div",
            { style: { fontSize: 10.5, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" } },
            `共 ${summary.turns || 0} 轮${when === "" ? "" : ` · 最近活动 ${when}`}`,
          ),
        );
        return h("div", { style: summaryStyle }, lines);
      };

      const toggleSummary = (id) => {
        setExpandedSummaries((previous) => toggleMembership(previous, id));
      };

      const summaryPreviewOf = (row) => {
        const summary = summaries[row.id];
        if (summary === undefined || summary === null) {
          return summaryState === "loading"
            ? "正在读取历史摘要…"
            : summaryState === "error"
              ? "历史摘要读取失败"
              : summaryState === "unavailable"
                ? "历史摘要暂不可用"
                : "（没有可用的历史摘要）";
        }
        const first = (summary.firstPrompt || (Array.isArray(summary.prompts) ? summary.prompts[0] : "") || "").trim();
        const result = (summary.lastResponse || "").trim();
        return first !== "" ? first : result !== "" ? result : "（没有可用的历史摘要）";
      };

      const summaryToggle = (id) => {
        const expanded = isExpanded(id);
        return h(
          "button",
          {
            type: "button",
            className: "bw-recycle-expand",
            "aria-expanded": expanded ? "true" : "false",
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleSummary(id);
            },
            style: summaryToggleStyle,
          },
          expanded ? "收起摘要" : "展开摘要",
        );
      };

      const rowStyle = {
        display: "block",
        padding: "10px 12px",
        borderTop: "1px solid var(--dsw-alias-border-l2)",
        cursor: "default",
      };
      const rowHeadStyle = { display: "flex", alignItems: "center", gap: 10, minWidth: 0 };
      const titleStyle = { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
      const metaStyle = { fontSize: 11, color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" };
      const summaryStyle = {
        marginTop: 7,
        padding: "7px 9px",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2, transparent) 55%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      };
      const summaryLabelStyle = {
        flex: "none",
        width: 28,
        fontSize: 10.5,
        lineHeight: "16px",
        color: "var(--dsw-alias-label-tertiary)",
        fontWeight: 600,
      };
      const summaryValueStyle = {
        flex: 1,
        minWidth: 0,
        fontSize: 11.5,
        lineHeight: 1.55,
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      };
      const summaryPreviewRowStyle = {
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginTop: 6,
        minWidth: 0,
      };
      const summaryPreviewLabelStyle = {
        flex: "none",
        fontSize: 10.5,
        lineHeight: "16px",
        fontWeight: 600,
        color: "var(--dsw-alias-label-tertiary)",
      };
      const summaryPreviewTextStyle = {
        flex: 1,
        minWidth: 0,
        fontSize: 11.5,
        lineHeight: 1.55,
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      };
      const summaryToggleStyle = {
        flex: "none",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 6,
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: 10.5,
        lineHeight: "16px",
        padding: "1px 7px",
        cursor: "pointer",
      };
      const badgeStyle = {
        flex: "none",
        fontSize: 10,
        lineHeight: 1,
        padding: "3px 7px",
        borderRadius: 999,
        color: "var(--dsw-alias-state-idle-primary)",
        background: "color-mix(in srgb, var(--dsw-alias-state-idle-primary) 12%, transparent)",
      };
      const menuItemStyle = {
        display: "block",
        width: "100%",
        border: 0,
        borderRadius: 6,
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: 12.5,
        textAlign: "left",
        padding: "7px 10px",
        cursor: "pointer",
      };

      const content =
        rows.length === 0
          ? h(
              "div",
              { style: { marginTop: 20, padding: "28px 0", textAlign: "center", color: "var(--dsw-alias-label-secondary)", fontSize: 12.5 } },
              "回收站是空的。归档会话被删除后会出现在这里。",
            )
          : h(
              "div",
              {
                style: {
                  marginTop: 16,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 10,
                  overflow: "hidden",
                  background: "var(--dsw-alias-bg-layer-1)",
                },
              },
              rows.map((row) =>
                h(
                  "div",
                  {
                    key: row.id,
                    className: "bw-recycle-row",
                    style: rowStyle,
                    onContextMenu: (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setMenu({ x: event.clientX, y: event.clientY, id: row.id });
                    },
                    "data-recycle-session": row.id,
                    "aria-label": "右键可还原或彻底删除；此条目不能打开",
                  },
                  h(
                    "div",
                    { style: rowHeadStyle },
                    h("span", { style: titleStyle }, row.title),
                    h("span", { style: metaStyle }, row.workspace),
                    h("span", { style: badgeStyle }, "已归档"),
                  ),
                  isExpanded(row.id)
                    ? h(
                        "div",
                        null,
                        renderSummary(row),
                        h(
                          "div",
                          { style: { display: "flex", justifyContent: "flex-end", marginTop: 4 } },
                          summaryToggle(row.id),
                        ),
                      )
                    : h(
                        "div",
                        { style: summaryPreviewRowStyle },
                        h("span", { style: summaryPreviewLabelStyle }, "摘要"),
                        h("span", { style: summaryPreviewTextStyle }, summaryPreviewOf(row)),
                        summaryToggle(row.id),
                      ),
                ),
              ),
            );

      return h(
        "div",
        { style: { height: "100%", overflow: "auto", padding: "24px 28px", color: "var(--dsw-alias-label-primary)" } },
        h("h1", { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, "回收站"),
        h(
          "p",
          { style: { margin: "6px 0 0", fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 } },
          "这里存放被“删除会话”移出的归档会话，共 " +
            rows.length +
            " 个。条目不能打开；标题下方是历史对话摘要，右键可还原或彻底删除。还原后仍保持归档状态。",
        ),
        purgeNotice === ""
          ? null
          : h(
              "div",
              {
                role: "status",
                style: {
                  marginTop: 12,
                  padding: "8px 10px",
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2, transparent) 55%, transparent)",
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 11.5,
                  lineHeight: 1.6,
                },
              },
              purgeNotice,
            ),
        content,
        menu === null
          ? null
          : h(
              "div",
              {
                className: "bw-recycle-menu",
                style: {
                  position: "fixed",
                  zIndex: 1200,
                  left: Math.min(menu.x, Math.max(8, window.innerWidth - 160)),
                  top: Math.min(menu.y, Math.max(8, window.innerHeight - 86)),
                  minWidth: 132,
                  padding: 4,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 8,
                  background: "var(--dsw-alias-bg-overlay)",
                  boxShadow: "0 8px 24px rgba(0,0,0,.16)",
                },
              },
              h(
                "button",
                {
                  type: "button",
                  onClick: (event) => {
                    event.stopPropagation();
                    recycleRemove(menu.id);
                    setMenu(null);
                  },
                  style: menuItemStyle,
                },
                "还原会话",
              ),
              h(
                "button",
                {
                  type: "button",
                  onClick: (event) => {
                    event.stopPropagation();
                    const row = rows.find((item) => item.id === menu.id);
                    setMenu(null);
                    setPurgeError("");
                    setConfirm({ id: menu.id, title: row?.title ?? "未命名会话" });
                  },
                  style: { ...menuItemStyle, color: "var(--dsw-alias-state-error-primary, #ef4444)" },
                },
                "彻底删除",
              ),
            ),
        confirm === null
          ? null
          : h(
              "div",
              {
                role: "dialog",
                "aria-label": "彻底删除会话",
                style: {
                  position: "fixed",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  zIndex: 1300,
                  width: 380,
                  maxWidth: "90vw",
                  padding: 20,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 12,
                  background: "var(--dsw-alias-bg-overlay, #fff)",
                  color: "var(--dsw-alias-label-primary)",
                  boxShadow: "0 16px 44px rgba(0, 0, 0, 0.20)",
                },
              },
                h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 650 } }, "彻底删除会话？"),
                h(
                  "p",
                  { style: { margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)" } },
                  `将永久删除「${confirm.title}」的会话日志和本地记录，无法恢复。`,
                ),
                purgeError === ""
                  ? null
                  : h(
                      "p",
                      { style: { margin: "8px 0 0", fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-state-error-primary, #ef4444)" } },
                      purgeError,
                    ),
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 } },
                  h(
                    "button",
                    {
                      type: "button",
                      disabled: purging,
                      onClick: () => setConfirm(null),
                      style: {
                        border: "1px solid var(--dsw-alias-border-l2)",
                        borderRadius: 7,
                        background: "transparent",
                        color: "inherit",
                        font: "inherit",
                        fontSize: 12.5,
                        padding: "7px 14px",
                        cursor: purging ? "default" : "pointer",
                      },
                    },
                    "取消",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      disabled: purging,
                      onClick: async () => {
                        if (purging) return;
                        setPurging(true);
                        setPurgeError("");
                        try {
                          const payload = await purgeRecycled(confirm.id);
                          const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
                          setPurgeNotice(
                            warnings.length > 0
                              ? `已彻底删除，但有部分关联数据未清理：${warnings.join("；")}`
                              : "已彻底删除：会话日志、投影缓存、工作区账户/归档、关联定时任务、Synapse 映射和备份引用已清理。",
                          );
                          setConfirm(null);
                        } catch (error) {
                          setPurgeError(error instanceof Error ? error.message : "彻底删除失败");
                        } finally {
                          setPurging(false);
                        }
                      },
                      style: {
                        border: 0,
                        borderRadius: 7,
                        background: "#ef4444",
                        color: "#fff",
                        font: "inherit",
                        fontSize: 12.5,
                        fontWeight: 600,
                        padding: "7px 14px",
                        cursor: purging ? "default" : "pointer",
                        opacity: purging ? 0.7 : 1,
                      },
                    },
                    purging ? "删除中…" : "确认删除",
                  ),
                ),
              ),
      );
    }


    const CONFIG_STYLE = {
      wrap: { display: "flex", flexDirection: "column", gap: 0, padding: "2px 0 8px" },
      title: { fontSize: 13, fontWeight: 600, margin: "0 0 4px" },
      section: {
        fontSize: 11.5,
        fontWeight: 650,
        color: "var(--dsw-alias-label-secondary)",
        margin: "12px 0 2px",
      },
      note: { fontSize: 11.5, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)", margin: "0 0 8px" },
      row: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 30,
        padding: "6px 0",
        borderTop: "1px solid var(--dsw-alias-border-l2)",
      },
      label: { flex: "1 1 auto", minWidth: 0, fontSize: 12.5 },
      hint: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginInlineStart: 6 },
      input: {
        width: 78,
        padding: "3px 6px",
        borderRadius: 5,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2)",
        color: "inherit",
        font: "inherit",
      },
      actions: { display: "flex", alignItems: "center", gap: 8, paddingTop: 10, flexWrap: "wrap" },
      button: {
        outline: "none",
        padding: "6px 12px",
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,0.35)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        cursor: "pointer",
      },
      buttonPrimary: {
        borderColor: "rgba(47,107,255,0.9)",
        background: "rgba(47,107,255,0.92)",
        color: "#ffffff",
        fontWeight: 600,
      },
      buttonDisabled: { opacity: 0.45, cursor: "default" },
      statusText: { fontSize: 11, opacity: 0.6 },
    };

    function ConfigPage({ view }) {
      const saved = getSettings();
      const [draft, setDraft] = React.useState(() => ({ ...saved }));
      const [justSaved, setJustSaved] = React.useState(false);

      if (view === "summary") {
        const current = getSettings();
        return h(
          "span",
          null,
          `${current.summaryCollapsed ? "摘要折叠" : "摘要展开"} · 最多保留 ${current.maxEntries} 条`,
        );
      }

      const update = (key, value) => {
        setJustSaved(false);
        setDraft((previous) => ({ ...previous, [key]: value }));
      };

      const dirty = Object.keys(DEFAULT_SETTINGS).some((key) => draft[key] !== saved[key]);

      const save = () => {
        if (!dirty) return;
        const next = saveSettings(draft);
        setDraft({ ...next });
        setJustSaved(true);
      };

      const reset = () => {
        setJustSaved(false);
        setDraft({ ...DEFAULT_SETTINGS });
      };

      const checkbox = (key, label, hint) =>
        h(
          "label",
          { style: CONFIG_STYLE.row },
          h("input", {
            type: "checkbox",
            checked: draft[key] === true,
            onChange: (event) => update(key, event.target.checked),
          }),
          h("span", { style: CONFIG_STYLE.label }, label),
          hint === undefined ? null : h("span", { style: CONFIG_STYLE.hint }, hint),
        );

      const number = (key, label, suffix, hint) =>
        h(
          "label",
          { style: CONFIG_STYLE.row },
          h("span", { style: CONFIG_STYLE.label }, label),
          hint === undefined ? null : h("span", { style: CONFIG_STYLE.hint }, hint),
          h("input", {
            type: "number",
            min: NUMERIC_LIMITS[key].min,
            max: NUMERIC_LIMITS[key].max,
            step: 1,
            value: String(draft[key]),
            onChange: (event) => update(key, Number(event.target.value)),
            style: CONFIG_STYLE.input,
          }),
          h("span", { style: CONFIG_STYLE.hint }, suffix),
        );

      const section = (title) => h("div", { style: CONFIG_STYLE.section }, title);

      return h(
        "div",
        { style: CONFIG_STYLE.wrap },
        h("h3", { style: CONFIG_STYLE.title }, "fans会话回收站清理"),
        h(
          "p",
          { style: CONFIG_STYLE.note },
          "管理归档回收站的历史摘要展开方式、保留条数和启动清理。彻底删除的确认、还原后仍归档、回收站条目不可点击等安全行为固定生效，不提供关闭开关。配置只保存在本机，且只出现在这个插件详情页。",
        ),
        section("摘要"),
        checkbox("summaryCollapsed", "摘要默认折叠为一行", "关闭后默认展开完整摘要"),
        number("summaryPrompts", "过程请求显示条数", "条", "0–5，0 表示不显示过程请求"),
        number("summaryResponses", "助手回复摘要条数", "条", "0–3，0 表示不显示回复摘要"),
        section("回收站维护"),
        number("maxEntries", "回收站最多保留记录", "条", "10–1000；超过后淘汰最早删除的记录"),
        checkbox("autoPrune", "启动时清理失效记录", "会话已取消归档时自动移除"),
        section("固定安全行为"),
        h(
          "div",
          { style: { ...CONFIG_STYLE.note, margin: "4px 0 0" } },
          "只有归档会话可以删除；还原后仍保持归档；回收站条目不可点击打开；彻底删除始终二次确认，并清理全部已知关联数据。",
        ),
        h(
          "div",
          { style: CONFIG_STYLE.actions },
          h(
            "button",
            {
              type: "button",
              onClick: save,
              disabled: !dirty,
              style: dirty ? { ...CONFIG_STYLE.button, ...CONFIG_STYLE.buttonPrimary } : { ...CONFIG_STYLE.button, ...CONFIG_STYLE.buttonDisabled },
            },
            "保存配置",
          ),
          h("button", { type: "button", style: CONFIG_STYLE.button, onClick: reset }, "恢复默认"),
          h(
            "span",
            { style: CONFIG_STYLE.statusText },
            dirty ? "有未保存的修改" : justSaved ? "已保存并生效" : "与已保存的设置一致",
          ),
        ),
        h("p", { style: CONFIG_STYLE.note }, "「恢复默认」只把表单改回默认值，仍需点「保存配置」才会生效。"),
      );
    }


    function RecycleIcon({ size = 16 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M3 4.5h10M6.2 4.5V3.4c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.1M4.4 4.5l.5 8.1c0 .5.4.9.9.9h4.4c.5 0 .9-.4.9-.9l.5-8.1M6.6 7v4M9.4 7v4",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    function register(ctx) {
      registerCtx = ctx;
      disposed = false;
      startupPruneAt = Date.now() + 30000;
      const disposeStyle = insertStyle();
      const slots = serviceOf(ctx, "slots");
      if (slots !== undefined && slots !== null && typeof slots.inject === "function") {
        ctx.effect(
          () =>
            slots.inject("plugins.bundle.config", () =>
              slots.register(
                { name: "plugins.bundle.config", key: BUNDLE_NAME },
                ConfigPage,
              ),
            ),
          "session-recycle: bundle config page",
        );
        ctx.effect(
          () =>
            slots.inject("sidebar.panellist", () =>
              slots.register(
                { name: "sidebar.panellist", id: "session-recycle", order: 27, label: () => "回收站" },
                RecycleIcon,
              ),
            ),
          "session-recycle: sidebar entry",
        );
        ctx.effect(
          () =>
            slots.inject("main", () =>
              slots.register(
                { name: "main", key: "session-recycle", inject: () => ({ ctx }) },
                RecyclePanel,
              ),
            ),
          "session-recycle: page",
        );
      }

      const contextMenus = serviceOf(ctx, "contextMenus");
      const workspacesService = serviceOf(ctx, "workspaces");
      if (contextMenus !== undefined && contextMenus !== null && workspacesService !== undefined && workspacesService !== null) {
        ctx.effect(
          () =>
            contextMenus.register({
              id: "session-recycle.delete",
              target: "session",
              order: 700,
              observe: () => [workspacesService.list],
              resolve: ({ sessionId }) => {
                const snapshot = workspacesService.list.getSnapshot();
                const variants = sessionIdVariants(sessionId);
                if (!snapshot.archivedSessionIds.some((id) => variants.includes(id))) return [];
                if (isRecycled(sessionId)) return [];
                return [
                  {
                    id: "recycle",
                    label: "删除会话",
                    icon: { key: "workspace.delete" },
                    afterContent: true,
                    run: () => recycleAdd(sessionId),
                  },
                ];
              },
            }),
          "session-recycle: archived-session menu",
        );
      }

      observer = new MutationObserver(schedulePaint);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-row-key"] });
      tick = window.setInterval(schedulePaint, 1500);
      window.addEventListener("focus", schedulePaint);
      const off = subscribeRecycle(schedulePaint);
      // 配置保存后立即按新 maxEntries 裁剪：回收站面板此刻通常没有挂载
      // （用户在插件详情页点保存），所以不能只靠面板 effect。
      const offSettings = subscribeSettings(() => {
        if (trimToMaxEntries()) {
          notifyRecycle();
          schedulePaint();
        }
      });
      schedulePaint();

      ctx.effect(
        () => () => {
          disposed = true;
          registerCtx = null;
          if (observer !== null) observer.disconnect();
          if (tick !== null) window.clearInterval(tick);
          window.removeEventListener("focus", schedulePaint);
          off();
          offSettings();
          disposeStyle();
          for (const row of document.querySelectorAll(`[${RECYCLED_ATTR}]`)) dropAttr(row, RECYCLED_ATTR);
        },
        "session-recycle: dispose",
      );
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = register;
    exports.__test = {
      RecyclePanel,
      RecycleIcon,
      ConfigPage,
      loadRecycleState,
      getRecycleState,
      recycleAdd,
      recycleRemove,
      trimToMaxEntries,
      isRecycled,
      purgeOverviewScene,
      purgeWorkspaceState,
      mergeSettings,
      getSettings,
      saveSettings,
      resetSettings,
      summaryExpanded,
      toggleMembership,
    };
    return exports;
  },
});
