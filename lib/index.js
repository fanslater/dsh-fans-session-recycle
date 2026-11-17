/**
 * Host half of dsh-fans-session-recycle.
 *
 * This half owns the narrow Host route used by the recycle bin: archived
 * Session history summaries, permanent deletion, and the associated durable
 * cleanup. The route is protected by a client-registered capability token; the
 * client generates it before use and re-registers after a Host reload.
 *
 * @module dsh-fans-session-recycle
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Stable Cordis plugin name. */
const name = "session-recycle";

/** Host-side recycle endpoint. */
const ROUTE = "/session-recycle/recycle-bin";

/** Client-registered capability token. */
let registeredToken = null;
const CLIENT_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** Session ids are UUID-like; reject path syntax before touching the disk. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Host services this plugin needs before it can register the route. */
export const inject = ["webServer"];

/** @returns the DSH home directory used by the Host process. */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/**
 * All plausible spellings of one Session's directory / projection file.
 * The catalog id is normally the bare UUID, while storage prefixes `session-`.
 * @param id - session id.
 * @returns both candidate names, deduplicated.
 */
function sessionNames(id) {
  const bare = id.startsWith("session-") ? id.slice("session-".length) : id;
  return [...new Set([id, `session-${bare}`])];
}

/**
 * Find the Session log directory and projection-cache file on disk.
 * @param id - session id.
 * @returns existing paths to remove.
 */
async function findSessionPaths(id) {
  const home = dshHome();
  const names = sessionNames(id);
  const found = new Set();

  const sessionsRoot = path.join(home, "sessions");
  const buckets = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(sessionsRoot, bucket.name);
    for (const sessionName of names) {
      const candidate = path.join(bucketPath, sessionName);
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat !== null && (stat.isDirectory() || stat.isFile())) found.add(candidate);
    }
  }
  for (const sessionName of names) {
    const direct = path.join(sessionsRoot, sessionName);
    const stat = await fs.stat(direct).catch(() => null);
    if (stat !== null && (stat.isDirectory() || stat.isFile())) found.add(direct);
  }

  const projectionRoot = path.join(home, "storages", "session_projcache", "sessions");
  for (const sessionName of names) {
    const candidate = path.join(projectionRoot, `${sessionName}.json`);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat !== null && stat.isFile()) found.add(candidate);
  }

  return [...found];
}

/**
 * Locate one Session's projection-cache JSON.
 * @param id - session id.
 * @returns the existing path, or null.
 */
async function findProjectionPath(id) {
  const root = path.join(dshHome(), "storages", "session_projcache", "sessions");
  for (const sessionName of sessionNames(id)) {
    const candidate = path.join(root, `${sessionName}.json`);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat !== null && stat.isFile()) return candidate;
  }
  return null;
}

/**
 * Read a compact history summary from the projection cache. The cache's
 * turnOutline already carries each turn's prompt and response; no session log
 * decompression is needed, and nothing beyond short clips leaves the Host.
 * @param id - session id.
 * @returns summary or null when the cache has no turn outline.
 */
async function summarizeSession(id) {
  const projection = await findProjectionPath(id);
  if (projection === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(projection, "utf8"));
  } catch {
    return null;
  }
  const rows = parsed?.record?.rows;
  const turns = rows?.turnOutline?.val?.turns;
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const clean = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
  const promptOf = (turn) => clean(turn?.prompt);
  const responseOf = (turn) => (typeof turn?.response === "string" ? turn.response.trim() : "");
  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  const greeting = (text) =>
    /^(?:hello|hi|hey|你好|您好|嗨|在吗|在么|谢谢|thanks)[!！。.,，\s]*$/i.test(text);

  // turnOutline clips prompts to ~50 chars; titleInput.first.text carries the
  // full first user prompt and is much better for recall.
  const fullFirst = clean(rows?.titleInput?.val?.first?.text);
  const raw = [];
  if (fullFirst !== "") raw.push(fullFirst);
  for (const turn of turns) {
    const prompt = promptOf(turn);
    if (prompt !== "") raw.push(prompt);
  }
  const seen = new Set();
  const unique = [];
  for (const prompt of raw) {
    // The turnOutline copy is a clipped prefix of the full titleInput prompt.
    const key = prompt.replace(/…$/, "").slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(prompt);
  }
  const substantive = unique.filter((prompt) => !greeting(prompt));
  const prompts = (substantive.length > 0 ? substantive : unique).slice(0, 6).map((prompt, index) => clip(prompt, index === 0 ? 1200 : 400));
  if (prompts.length === 0) return null;

  const lastTurn = [...turns].reverse().find((turn) => promptOf(turn) !== "" || responseOf(turn) !== "");
  const responses = turns.map(responseOf).filter((text) => text !== "").map((text) => clip(text, 300));
  return {
    turns: turns.length,
    firstPrompt: prompts[0] ?? "",
    prompts,
    lastPrompt: clean(lastTurn?.prompt) || prompts[prompts.length - 1] || "",
    responses: responses.slice(-3),
    lastResponse: responses[responses.length - 1] ?? "",
  };
}

/**
 * Close a live Session handle when the Host exposes a close hook, so Windows
 * does not keep the log file locked while the files are removed.
 * @param ctx - Host plugin context.
 * @param id - session id.
 */
async function closeActive(ctx, id) {
  const sessions = ctx.get("sessions") ?? ctx.sessions;
  const active = sessions?.get?.(id);
  if (active === undefined || active === null) return;
  if (typeof active.close === "function") {
    await active.close("session-recycle permanent delete");
  } else if (typeof active.dispose === "function") {
    await active.dispose();
  }
}

/**
 * Remove every reference to one session id from a JSON value.
 * Removes matching strings from arrays, objects whose `dshSessionId` is the id
 * (Synapse threads), and object fields whose value is exactly the id.
 * @param value - parsed JSON.
 * @param id - session id.
 * @returns scrubbed value and whether anything changed.
 */
function scrubSessionReferences(value, id) {
  // Storage mixes `session-<uuid>` and bare-uuid spellings across plugins.
  const ids = new Set([id]);
  if (id.startsWith("session-")) ids.add(id.slice("session-".length));
  else ids.add(`session-${id}`);
  const matches = (candidate) => typeof candidate === "string" && ids.has(candidate);
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) {
      const next = [];
      for (const item of node) {
        if (item !== null && typeof item === "object" && matches(item.dshSessionId)) {
          changed = true;
          continue;
        }
        next.push(walk(item));
      }
      return next;
    }
    if (node !== null && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const current = node[key];
        if (Array.isArray(current)) {
          const filtered = current.filter((item) => !matches(item));
          if (filtered.length !== current.length) changed = true;
          node[key] = walk(filtered);
        } else if (current !== null && typeof current === "object" && matches(current.dshSessionId)) {
          // Synapse may store threads in a map instead of an array.
          delete node[key];
          changed = true;
        } else if (matches(current)) {
          delete node[key];
          changed = true;
        } else {
          node[key] = walk(current);
        }
      }
    }
    return node;
  };
  return { value: walk(value), changed };
}

/**
 * Scrub one JSON state file, writing atomically only when it changed.
 * @param file - absolute path.
 * @param id - session id.
 * @returns true when at least one reference was removed.
 */
async function scrubJsonFile(file, id) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`无法解析关联状态文件: ${file}`);
  }
  const result = scrubSessionReferences(parsed, id);
  if (!result.changed) return false;
  const temporary = `${file}.busy-purge-${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(result.value, null, 2), "utf8");
  await fs.rename(temporary, file);
  return true;
}

/**
 * Remove schedule tasks whose target is this Session.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns removed count and non-fatal warnings.
 */
async function removeSessionSchedules(ctx, id) {
  const schedule = ctx.get("schedule") ?? ctx.schedule;
  if (schedule === undefined || schedule === null || typeof schedule.catalog !== "function" || typeof schedule.edit !== "function") {
    return { removed: 0, warnings: ["定时任务服务不可用，未检查关联定时任务"] };
  }
  let catalog;
  try {
    if (typeof schedule.catalog === "function") {
      catalog = await schedule.catalog();
    } else if (typeof schedule.list === "function") {
      const page = await schedule.list({ limit: 500 });
      catalog = page?.items ?? [];
    } else {
      return { removed: 0, warnings: ["定时任务服务缺少读取接口，未清理关联定时任务"] };
    }
  } catch {
    return { removed: 0, warnings: ["读取定时任务失败，未清理关联定时任务"] };
  }
  let removed = 0;
  const warnings = [];
  const bare = (value) => (value.startsWith("session-") ? value.slice("session-".length) : value);
  for (const entry of catalog) {
    const target = entry?.target;
    if (target?.kind !== "session" || typeof target.sessionId !== "string" || bare(target.sessionId) !== bare(id)) continue;
    try {
      const result = await schedule.edit({ id: entry.id, action: "delete" });
      if (result?.deleted === true) removed += 1;
      else if (result?.code !== "schedule_not_found") warnings.push(`定时任务 ${entry.id} 未删除`);
    } catch {
      warnings.push(`定时任务 ${entry.id} 删除失败`);
    }
  }
  return { removed, warnings };
}

/**
 * Remove the session from Synapse workspace/thread mappings.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns true when the file changed.
 */
async function scrubSynapse(ctx, id) {
  const file = path.join(dshHome(), "synapse", "workspaces.json");
  try {
    return await scrubJsonFile(file, id);
  } catch (error) {
    ctx.logger?.warn?.(`session-recycle: synapse cleanup failed: ${error?.message ?? error}`);
    throw error;
  }
}

/**
 * Remove the session from workspace registry backup snapshots.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns number of changed backup files.
 */
async function scrubWorkspaceBackups(ctx, id) {
  const directory = path.join(dshHome(), "storages");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let changed = 0;
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("workspace.json.bak-")) continue;
    const file = path.join(directory, entry.name);
    try {
      if (await scrubJsonFile(file, id)) changed += 1;
    } catch (error) {
      warnings.push(`备份 ${entry.name} 清理失败: ${error?.message ?? error}`);
    }
  }
  return { changed, warnings };
}

/**
 * Permanently erase one archived Session: files, Workspace accounting, archive
 * membership, schedules, Synapse mappings, and workspace backup references.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns removal counts and non-fatal warnings.
 */
async function purgeSession(ctx, id) {
  const registry = ctx.get("workspaceRegistry") ?? ctx.workspaceRegistry;
  if (registry === undefined || registry === null) {
    throw new Error("Host Workspace registry is unavailable");
  }
  const archived = registry.archivedSessionIds;
  const isArchived = typeof archived?.has === "function" ? archived.has(id) : [...(archived ?? [])].includes(id);
  if (!isArchived) {
    throw Object.assign(new Error("该会话不在归档集合中，拒绝彻底删除"), { code: "NOT_ARCHIVED" });
  }

  await closeActive(ctx, id);

  // Capture owners before deleting the header: Workspace.sessionIds filters by
  // the session's cwd header, so an after-delete read could miss the account.
  const owners = registry
    .list()
    .filter((workspace) => workspace.sessionIds.includes(id))
    .map((workspace) => workspace.id);

  const paths = await findSessionPaths(id);
  for (const target of paths) {
    const stat = await fs.lstat(target).catch(() => null);
    await fs.rm(target, { recursive: stat?.isDirectory() === true, force: true });
  }

  for (const ownerId of owners) {
    const workspace = registry.get(ownerId);
    if (workspace !== undefined) await workspace.detachSession(id);
  }
  await registry.unarchiveSession(id);

  const cleanup = { schedules: 0, synapse: false, workspaceBackups: 0 };
  const warnings = [];

  try {
    const result = await removeSessionSchedules(ctx, id);
    cleanup.schedules = result.removed;
    warnings.push(...result.warnings);
  } catch (error) {
    warnings.push(`定时任务清理失败: ${error?.message ?? error}`);
  }

  try {
    cleanup.synapse = await scrubSynapse(ctx, id);
  } catch (error) {
    warnings.push(`Synapse 引用清理失败: ${error?.message ?? error}`);
  }

  try {
    const result = await scrubWorkspaceBackups(ctx, id);
    cleanup.workspaceBackups = result.changed;
    warnings.push(...result.warnings);
  } catch (error) {
    warnings.push(`工作区备份清理失败: ${error?.message ?? error}`);
  }

  return { removed: paths.length, cleanup, warnings };
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Route handler: token, method, body, and the one supported action.
 * @param ctx - Host plugin context.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handle(ctx, req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "仅支持 POST" });
    return;
  }

  let raw = "";
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
        sendJson(res, 413, { ok: false, message: "请求体过大" });
        return;
      }
    }
  } catch {
    sendJson(res, 400, { ok: false, message: "无法读取请求体" });
    return;
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, message: "请求体不是合法 JSON" });
    return;
  }
  if (request === null || typeof request !== "object") {
    sendJson(res, 400, { ok: false, message: "请求参数不合法" });
    return;
  }

  // Electron renders the SPA over file://, where tapIndex cannot inject a
  // token. The renderer registers its own random capability instead. This
  // branch only stores the token; it reads no session and deletes nothing.
  if (request.action === "register") {
    if (typeof request.token !== "string" || !CLIENT_TOKEN.test(request.token)) {
      sendJson(res, 400, { ok: false, message: "客户端令牌不合法" });
      return;
    }
    registeredToken = request.token;
    sendJson(res, 200, { ok: true });
    return;
  }

  const provided =
    (typeof request.token === "string" ? request.token : null) ??
    req.headers["x-session-recycle-token"];
  if (provided !== registeredToken) {
    sendJson(res, 403, { ok: false, message: "无效的回收站删除令牌" });
    return;
  }

  if (request.action === "summaries") {
    if (!Array.isArray(request.sessionIds) || request.sessionIds.length === 0 || request.sessionIds.length > 100) {
      sendJson(res, 400, { ok: false, message: "摘要请求参数不合法" });
      return;
    }
    const ids = [...new Set(request.sessionIds)].filter(
      (id) => typeof id === "string" && SESSION_ID.test(id),
    );
    const summaries = {};
    for (const id of ids) {
      try {
        summaries[id] = await summarizeSession(id);
      } catch {
        summaries[id] = null;
      }
    }
    sendJson(res, 200, { ok: true, summaries });
    return;
  }

  if (request.action !== "purge" || typeof request.sessionId !== "string" || !SESSION_ID.test(request.sessionId)) {
    sendJson(res, 400, { ok: false, message: "请求参数不合法" });
    return;
  }

  try {
    const result = await purgeSession(ctx, request.sessionId);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const code = error?.code;
    const message =
      code === "NOT_ARCHIVED"
        ? error.message
        : code === "EBUSY" || code === "EPERM"
          ? "会话文件仍被占用，请先切换到其他会话后再试"
          : error instanceof Error
            ? error.message
            : "彻底删除失败";
    ctx.logger?.warn?.(`session-recycle: purge ${request.sessionId} failed: ${message}`);
    sendJson(res, code === "NOT_ARCHIVED" ? 409 : 500, { ok: false, message });
  }
}

/**
 * Register the narrow recycle route.
 * @param ctx - Host plugin context.
 */
function apply(ctx) {
  const webServer = ctx.get("webServer") ?? ctx.webServer;
  if (webServer === undefined || webServer === null) {
    ctx.logger?.warn?.("session-recycle: webServer unavailable; recycle route disabled");
    return;
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: "exact",
        path: ROUTE,
        handler: (req, res) => handle(ctx, req, res),
      }),
    "session-recycle: recycle route",
  );

  ctx.logger?.info?.("session-recycle: token-gated recycle route registered");
}

export { apply, name, scrubSessionReferences, summarizeSession };
