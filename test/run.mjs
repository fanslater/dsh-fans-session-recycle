import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const file = new URL("../lib/client.js", import.meta.url);
const store = new Map();
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
};
let captured;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        captured = definition.factory((name) => (name === "react" ? fakeReact : {}));
      },
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    dispatchEvent() {},
  },
  document: {
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
    body: {},
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  CustomEvent: class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(file, "utf8"), sandbox, { filename: String(file) });

const t = captured.__test;
store.set(
  "dsh-plugin-busy-workspace:recycle:v1",
  JSON.stringify({ version: 1, sessions: { "session-a": { deletedAt: 123 } } }),
);
const state = t.getRecycleState();
assert.equal(state.sessions["session-a"].deletedAt, 123);
assert.equal(store.has("dsh-plugin-busy-workspace:recycle:v1"), false);
assert.ok(store.has("dsh-plugin-session-recycle:state:v1"));
assert.equal(t.isRecycled("session-a"), true);

t.recycleRemove("session-a");
assert.equal(t.isRecycled("session-a"), false);
t.recycleAdd("session-b");
assert.equal(t.isRecycled("session-b"), true);

// Config defaults, clamping, persistence, and the config page.
assert.equal(t.mergeSettings({}).summaryCollapsed, true);
assert.equal(t.mergeSettings({ summaryPrompts: 99 }).summaryPrompts, 5);
assert.equal(t.mergeSettings({ summaryResponses: -1 }).summaryResponses, 0);
assert.equal(t.mergeSettings({ maxEntries: 1 }).maxEntries, 10);
t.saveSettings({ summaryCollapsed: false, maxEntries: 10 });
assert.equal(t.getSettings().summaryCollapsed, false);
assert.equal(t.getSettings().maxEntries, 10);

// Regression: the summary expand toggle must flip in BOTH default modes.
// (Default-collapsed used to delete from the set instead of adding, so the
// 展开摘要 button looked completely dead.)
for (const defaultExpanded of [false, true]) {
  let expanded = new Set();
  const initiallyExpanded = t.summaryExpanded(expanded, "session-x", defaultExpanded);
  expanded = t.toggleMembership(expanded, "session-x");
  const afterFirstClick = t.summaryExpanded(expanded, "session-x", defaultExpanded);
  expanded = t.toggleMembership(expanded, "session-x");
  const afterSecondClick = t.summaryExpanded(expanded, "session-x", defaultExpanded);
  assert.equal(afterFirstClick, !initiallyExpanded, `defaultExpanded=${defaultExpanded}: first click did not flip the summary`);
  assert.equal(afterSecondClick, initiallyExpanded, `defaultExpanded=${defaultExpanded}: second click did not restore the summary`);
}

// The panel must keep wiring the toggle through the shared helper: a future
// edit must not reintroduce the inverted default-collapsed branch.
const clientSource = readFileSync(file, "utf8");
assert.ok(clientSource.includes("toggleMembership(previous, id)"), "toggleSummary must delegate to toggleMembership");
assert.ok(!clientSource.includes("currentlyCollapsed"), "the inverted toggle branch must not come back");

// maxEntries evicts the oldest record, keeping the newest.
for (let i = 0; i < 12; i += 1) t.recycleAdd(`session-extra-${i}`);
const capped = t.getRecycleState();
assert.ok(Object.keys(capped.sessions).length <= 10);
assert.ok(capped.sessions["session-extra-11"] !== undefined);
assert.ok(capped.sessions["session-extra-0"] === undefined);

// Saving a smaller maxEntries must trim immediately, without waiting for the
// recycle panel to mount (the user is on the plugin detail page when saving).
t.saveSettings({ maxEntries: 200 });
for (let i = 20; i < 35; i += 1) t.recycleAdd(`session-trim-${i}`);
assert.ok(Object.keys(t.getRecycleState().sessions).length > 10);
t.saveSettings({ maxEntries: 10 });
assert.equal(t.trimToMaxEntries(), true);
assert.ok(Object.keys(t.getRecycleState().sessions).length <= 10);
assert.ok(t.getRecycleState().sessions["session-trim-34"] !== undefined);
assert.ok(t.getRecycleState().sessions["session-trim-20"] === undefined);
assert.equal(t.trimToMaxEntries(), false, "a second trim must be a no-op");

// The trim must also be wired to the settings store so a save alone applies it.
assert.ok(clientSource.includes("const offSettings = subscribeSettings("), "settings subscription must exist");
assert.ok(clientSource.includes("trimToMaxEntries()"), "the subscription must call trimToMaxEntries");
// Restore the panel fixture after the eviction test.
t.saveSettings({ summaryCollapsed: true, maxEntries: 200 });
if (!t.isRecycled("session-b")) t.recycleAdd("session-b");

store.set("dsh-plugin-busy-workspace:state:v2", JSON.stringify({ version: 2, sessions: { "session-b": { phase: "seen" }, other: { phase: "seen" } } }));
t.purgeWorkspaceState("session-b");
const workspaceState = JSON.parse(store.get("dsh-plugin-busy-workspace:state:v2"));
assert.equal(workspaceState.sessions["session-b"], undefined);
assert.ok(workspaceState.sessions.other);

store.set("dsh-session-overview.scene.v1", JSON.stringify({ version: 1, savedAt: 1, sessions: { "session-b": { running: true }, other: {} } }));
t.purgeOverviewScene("session-b");
const scene = JSON.parse(store.get("dsh-session-overview.scene.v1"));
assert.equal(scene.sessions["session-b"], undefined);
assert.ok(scene.sessions.other);

const texts = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out);
    return out;
  }
  if (typeof node === "object" && node.children !== undefined) texts(node.children, out);
  return out;
};
const sessions = {
  list: {
    getSnapshot: () => ({ byId: { "session-b": { title: "归档会话", blank: false, origin: "main" } } }),
    subscribe: () => () => {},
  },
};
const workspaces = {
  list: {
    getSnapshot: () => ({ items: [{ workspaceId: "w1", title: "工作区 A", sessionIds: ["session-b"] }], archivedSessionIds: ["session-b"] }),
    subscribe: () => () => {},
  },
};
const ctx = {
  get: (key) => (key === "sessions" ? sessions : key === "workspaces" ? workspaces : undefined),
};
const panel = texts(t.RecyclePanel({ ctx })).join(" ");
for (const needle of ["回收站", "归档会话", "已归档", "展开摘要"]) {
  assert.ok(panel.includes(needle), `panel missing ${needle}`);
}
const config = texts(t.ConfigPage({ view: "page" })).join(" ");
for (const needle of ["摘要默认折叠为一行", "过程请求显示条数", "回收站最多保留记录", "启动时清理失效记录"]) {
  assert.ok(config.includes(needle), `config missing ${needle}`);
}
console.log("session recycle checks passed");
