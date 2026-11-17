# Changelog

## [1.0.2] — 2026-11-10

- Renamed the package to `dsh-fans-session-recycle`; the client bundle
  registration id and the config-page key follow the new name. The
  `localStorage` keys and the host route keep their original names, so existing
  settings and recycle records carry over.
- Installed from a packed tarball (`file:`) instead of a link to the source
  directory.
- Fixed the recycle-bin **展开摘要 / 收起摘要** button doing nothing when the
  default-collapsed setting is active. The toggle deleted the row from the
  expanded set instead of adding it, so the panel never re-rendered in the
  expanded state. The toggle now flips membership unconditionally, which works
  in both default modes; a regression test covers both.
- No configuration or storage-key changes; existing settings and recycle
  records are untouched.

---

## [1.0.1] — 2026-11-09

- Aligned the config page buttons with the fans family: 保存配置 now uses the blue solid primary style, 恢复默认 uses the transparent grey-outline style.
- 保存配置 is disabled (greyed out) until the draft differs from the saved settings, with tri-state status text (有未保存的修改 / 已保存并生效 / 与已保存的设置一致).
- 恢复默认 now only resets the form; changes take effect only after 保存配置.
---

## [1.0.0] — 2026-11-07

- Split the cleanup/recycle half out of `dsh-plugin-busy-workspace`.
- Archived Sessions get **Delete session** below **Unarchive**, with the shipped
  trash icon.
- Sidebar **Recycle Bin**: non-clickable entries, collapsible history
  summaries, restore, and permanent delete.
- Permanent delete uses a centered floating confirmation card without a
  backdrop.
- The Host route is protected by a client-registered capability token; no index
  injection is required (important for Electron's `file://` renderer).
- Permanent delete clears the session log, projection cache, Workspace
  accounting/archive, schedules targeting the Session, Synapse mappings,
  workspace backup references, the sorting plugin's sticky state, and Session
  Overview's scene entry.
- Migrates the old `dsh-plugin-busy-workspace:recycle:v1` record to
  `dsh-plugin-session-recycle:state:v1`.
- Added detail-page options: collapsed-by-default summaries, process/response
  counts, recycle-bin entry cap, and startup pruning. Permanent-delete cleanup
  remains fixed to the full known scope.
