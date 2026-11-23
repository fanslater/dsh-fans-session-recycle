[English](./README.en.md) | **简体中文**

# fans会话回收站清理

为 DSH 侧栏中的**已归档会话**提供“删除会话 → 回收站 → 还原 / 彻底删除”的完整流程。

## 一、删除会话

- 只有归档会话的右键菜单会出现「删除会话」；
- 动作通过 `ctx.contextMenus` 注册，顺序 700，排在「取消归档」下方；
- 图标使用官方 `workspace.delete` 垃圾桶；
- 点击后不删除数据：原工作区行隐藏，记录写入
  `localStorage` 的 `dsh-plugin-session-recycle:state:v1`，跨 DSH 重启保留。

## 二、回收站

侧栏一级入口「回收站」列出被移出的归档会话。

- 条目**不能单击/双击打开**，避免误开历史或新会话；
- 标题下方默认折叠显示一行摘要，点「展开摘要」后显示：
  - 完整首轮任务；
  - 后续过程请求；
  - 最近请求；
  - 最近 N 轮助手回复摘要（默认 3，可在插件配置里调 0–3）；
  - 轮次和最近活动时间。
- 摘要来自 Host 的 session projection cache，通过 token 保护的本地路由读取。
- 隐藏只对**仍处于归档**的会话生效：若你在 DSH 里对某个会话「取消归档」，它会自动回到原工作区（即使关闭了「启动时清理失效记录」、记录还在），不会出现「工作区看不到、回收站也不列出」的情况。

## 三、还原

右键「还原会话」：

- 取消回收站记录；
- 行回到原工作区；
- **仍然保持归档状态**，不会自动变成普通会话。

## 四、彻底删除

右键「彻底删除」会弹出居中的浮动确认卡（无背景遮罩、不置灰其他 UI）：

- `取消`：不做任何修改；
- 红色 `确认删除`：执行永久清理。

清理范围：

1. session 日志目录（整个 `session-<id>/`）；
2. projection cache JSON；
3. Workspace 账户 `detachSession`；
4. 归档集合 `unarchiveSession`；
5. 以该会话为目标的定时任务；
6. `~/.dsh/synapse/workspaces.json` 中的 `dshSessionId` 线程、隐藏 id 和其他精确引用；
7. `~/.dsh/storages/workspace.json.bak-*` 中的会话引用；
8. 本插件回收站记录；
9. 排序插件的 sticky 状态（`dsh-plugin-busy-workspace:state:v2`）；
10. 会话总览 `dsh-session-overview.scene.v1` 本地记录。

不会清理：

- 共享附件（内容寻址，可能被其他会话引用）；
- DSH 日志/遥测；
- OpenViking 等外部记忆；
- 系统级/第三方备份（`workspace.json.bak-*` 除外）。

## 五、数据迁移

首次加载时会把旧插件的
`dsh-plugin-busy-workspace:recycle:v1`
迁移到
`dsh-plugin-session-recycle:state:v1`，然后删除旧 key。

## 六、插件配置

配置只注册在 `plugins.bundle.config`（key = 本包名），只出现在本插件详情页：

- **摘要**：摘要默认折叠为一行、过程请求显示条数（0–5）、助手回复摘要条数（0–3）；
- **回收站维护**：最多保留记录（10–1000）、启动时清理失效记录；
- **固定安全行为**：只有归档会话可删除、还原后仍归档、回收站条目不可点击、彻底删除始终二次确认并清理全部已知关联数据。

配置字段：`summaryCollapsed`、`summaryPrompts`、`summaryResponses`、`maxEntries`、`autoPrune`。

点「保存配置」后**立即生效，无需刷新或重启客户端**：摘要相关三项直接作用于下一次面板渲染，`maxEntries` 在保存瞬间就裁剪本地记录，`autoPrune` 在下一个绘制周期（≤1.5 秒）参与清理。

**不会**出现在 DSH【设置】中。

## 七、安装

在 DSH Desktop 的 profile 中通过 `file:` tarball 快照安装本插件（包名 `dsh-fans-session-recycle`）。与
`dsh-fans-session-monitor`（fans工作区会话状态监测：排序、高亮、选中、会话总览）相互独立，可分别启用。

## 八、验证

```bash
node --check lib/client.js
node --check lib/index.js
node test/run.mjs
```

## 九、安全说明

Host 路由 `/session-recycle/recycle-bin` 只接受 `POST`。摘要和彻底删除需要
`x-session-recycle-token`（或请求体 `token`）；客户端首次使用生成随机能力令牌并通过
`register` 动作登记，Host 重载后会自动重新登记。`register` 只保存令牌，不读会话、不删除。
