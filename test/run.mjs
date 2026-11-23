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

// A recycled row is hidden only while its Session is still archived. When the
// user unarchives a Session outside the plugin the row must come back, otherwise
// turning autoPrune off (which keeps the record) would hide that Session forever.
const records = { "session-a": { deletedAt: 1 } };
assert.equal(t.shouldHideRecycled("session-a", records, new Set(["session-a"]), true, new Set()), true);
assert.equal(t.shouldHideRecycled("session-a", records, new Set(), true, new Set()), false, "unarchived Session must reappear");
assert.equal(t.shouldHideRecycled("session-a", records, new Set(), false, new Set()), true, "before the archive set is ready, keep hiding");
assert.equal(t.shouldHideRecycled("session-b", records, new Set(["session-a"]), true, new Set()), false, "no record means no hiding");
assert.equal(t.shouldHideRecycled("session-a", records, new Set(), true, new Set(["session-a"])), true, "purged ids stay hidden");

// DSH counts every mounted row for its "show more" watermark, so hiding rows by
// CSS leaves a dead 「展开其余 N 个会话」 control. It must be suppressed when no
// further visible row remains, and kept whenever expanding would reveal one.
assert.equal(t.overflowIsDead(0, 0, false), true, "all rows hidden: the control is dead");
assert.equal(t.overflowIsDead(5, 5, false), true, "nothing left to reveal: dead");
assert.equal(t.overflowIsDead(6, 5, false), false, "one more visible row: keep");
assert.equal(t.overflowIsDead(5, 4, false), false, "one more visible row: keep");
assert.equal(t.overflowIsDead(0, 0, true), false, "expanded group keeps its collapse control");
assert.equal(t.overflowIsDead(6, 6, true), false, "expanded group keeps its collapse control");

// The guard must be wired into paint() and styled, otherwise it never runs.
assert.ok(clientSource.includes("applyOverflowGuard("), "paint must call applyOverflowGuard");
assert.ok(clientSource.includes("data-session-recycle-dead"), "the dead-overflow attribute/rule must exist");

// DOM contract: a workspace whose sessions are all recycled must lose the
//「展开其余 N 个会话」control, while a workspace that still has a revealable
// row keeps it. Uses a tiny DOM stub through the module's sandbox document.
function makeRow(id, recycled) {
  const attrs = { "data-row-key": `session:${id}` };
  if (recycled) attrs["data-session-recycle"] = "true";
  return {
    getAttribute(n) { return attrs[n] ?? null; },
    setAttribute(n, v) { attrs[n] = String(v); },
    removeAttribute(n) { delete attrs[n]; },
  };
}
function makeGroup(workspaceId, rows, expanded) {
  const overflow = {
    attrs: { "data-row-key": `overflow:${workspaceId}`, "aria-expanded": expanded ? "true" : "false" },
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
  };
  const header = {
    getAttribute(n) { return n === "data-row-key" ? `workspace:${workspaceId}` : null; },
  };
  return {
    overflow,
    querySelector(selector) {
      if (selector.includes("overflow:")) return overflow;
      if (selector.includes("workspace:")) return header;
      return null;
    },
    querySelectorAll() { return rows; },
  };
}

const sessionsById = {};
const ids = [];
for (let i = 1; i <= 6; i += 1) {
  const id = `s${i}`;
  ids.push(id);
  sessionsById[id] = { id, blank: false };
}
const workspaceSnapshot = {
  phase: "ready",
  items: [{ workspaceId: "w1", title: "检查代码", path: "/x", sessionIds: ids }],
  archivedSessionIds: ids,
};

// 场景 A：6 个会话全部在回收站，水位只挂载 5 行 —— 按钮应被判为死按钮。
const allRecycled = {};
for (const id of ids) allRecycled[id] = { deletedAt: 1 };
const groupA = makeGroup("w1", ids.slice(0, 5).map((id) => makeRow(id, true)), false);
let groupSections = [groupA];
sandbox.document.querySelectorAll = (selector) => (selector.includes("_groupSection") ? groupSections : []);
t.applyOverflowGuard(allRecycled, new Set(ids), true, sessionsById, workspaceSnapshot);
assert.equal(groupA.overflow.getAttribute("data-session-recycle-dead"), "true", "all-recycled group hides the dead control");

// 场景 B：只有第 6 个（尚未挂载）在回收站 —— 也没有可展开的可见行，仍应隐藏。
const lastRecycled = { s6: { deletedAt: 1 } };
const groupB = makeGroup("w1", ids.slice(0, 5).map((id) => makeRow(id, false)), false);
groupSections = [groupB];
t.applyOverflowGuard(lastRecycled, new Set(ids), true, sessionsById, workspaceSnapshot);
assert.equal(groupB.overflow.getAttribute("data-session-recycle-dead"), "true", "hidden-only remainder hides the control");

// 场景 C：没有回收站记录 —— 展开确实能露出第 6 条，必须保留按钮。
const groupC = makeGroup("w1", ids.slice(0, 5).map((id) => makeRow(id, false)), false);
groupSections = [groupC];
t.applyOverflowGuard({}, new Set(ids), true, sessionsById, workspaceSnapshot);
assert.equal(groupC.overflow.getAttribute("data-session-recycle-dead"), "false", "revealable row keeps the control");

// 场景 D：已展开（aria-expanded=true）—— 保留「收起」。
const groupD = makeGroup("w1", ids.map((id) => makeRow(id, true)), true);
groupSections = [groupD];
t.applyOverflowGuard(allRecycled, new Set(ids), true, sessionsById, workspaceSnapshot);
assert.equal(groupD.overflow.getAttribute("data-session-recycle-dead"), "false", "expanded group keeps its collapse control");

sandbox.document.querySelectorAll = () => [];
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
