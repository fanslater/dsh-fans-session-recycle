**English** | [简体中文](./README.md)

# fans Session Recycle Bin

Adds a complete **Delete session → recycle bin → restore / permanently delete**
flow for archived Sessions in the DSH sidebar.

## Delete session

- Only archived Sessions show **Delete session** in the context menu.
- The action is registered through `ctx.contextMenus` at order 700, below
  **Unarchive**, with the shipped trash icon `workspace.delete`.
- Deleting changes no data: the original row is hidden and the id is stored in
  `dsh-plugin-session-recycle:state:v1`, surviving a DSH restart.

## Recycle Bin

A first-class sidebar entry lists the moved archived Sessions.

- Entries cannot be opened by click or double-click.
- The summary is folded to one line by default; **Expand summary** shows the
  full first task, process prompts, the most recent prompt, the latest N
  assistant response excerpts (default 3, configurable 0–3), and the
  turn/last-activity footer.
- Summaries come from the Host session projection cache through a
  token-protected local route.
- Hiding only applies to Sessions that are **still archived**: unarchiving one
  in DSH brings its row straight back to the original workspace, even when
  autoPrune is off and the record survives — it can never end up invisible in
  both the workspace and the Recycle Bin.
- When **every** Session of a workspace sits in the Recycle Bin, DSH still draws
  「展开其余 N 个会话」 from `session count − watermark`. The plugin hides that
  dead control (clicking it changed nothing but the label); it is kept whenever a
  revealable row exists, and the collapse control always stays once expanded.

## Restore

**Restore session** removes the recycle record and returns the row to its
original workspace. The Session remains archived.

## Permanently delete

**Permanently delete** opens a centered floating confirmation card with no dark
backdrop. `Cancel` changes nothing; the red `Confirm delete` performs the
permanent cleanup:

1. the whole `session-<id>/` log directory;
2. the projection-cache JSON;
3. Workspace accounting (`detachSession`) and the archive set;
4. schedules targeting this Session;
5. `~/.dsh/synapse/workspaces.json` thread/hidden/exact references;
6. `~/.dsh/storages/workspace.json.bak-*` references;
7. this plugin's recycle record;
8. the sorting plugin's sticky state
   (`dsh-plugin-busy-workspace:state:v2`);
9. Session Overview's `dsh-session-overview.scene.v1` entry.

Not cleaned: shared content-addressed attachments, DSH logs/telemetry, external
memories, and OS/third-party backups other than `workspace.json.bak-*`.

## State migration

On first load the old
`dsh-plugin-busy-workspace:recycle:v1`
record is migrated to
`dsh-plugin-session-recycle:state:v1`, then the old key is removed.

## Configuration and installation

Registered only at `plugins.bundle.config` (key = package name), never in DSH
Settings:

- **Summary**: collapsed by default, process prompts (0–5), response excerpts
  (0–3);
- **Recycle Bin**: maximum entries (10–1000), prune invalid records on startup;
- **Fixed safety behaviour**: archived Sessions only, restore keeps archived,
  entries are non-clickable, and permanent delete always confirms and cleans all
  known related data.

Fields: `summaryCollapsed`, `summaryPrompts`, `summaryResponses`, `maxEntries`,
`autoPrune`.

Every option takes effect as soon as **Save configuration** is pressed — no page
refresh and no restart: the summary options apply to the next panel render,
`maxEntries` trims the stored records at save time, and `autoPrune` joins the
next paint pass (≤1.5 s).

Install the directory with a `link:` dependency and enable
`dsh-fans-session-recycle` in the bundle. It is independent of
`dsh-fans-session-monitor` (sorting, highlighting, selection, Session Overview)
and either can be enabled alone.

## Verification

```bash
node --check lib/client.js
node --check lib/index.js
node test/run.mjs
```

## Security

The Host route `/session-recycle/recycle-bin` accepts only `POST`. Summary and
purge calls require `x-session-recycle-token` (or a body `token`). The client
generates a random capability, registers it with the `register` action, and
re-registers after a Host reload. Registration only stores the token; it reads
no Session and deletes nothing.
