# @local/dsh-prompt-hint

在新任务（New Session）页面的「工作区 / 模式选择」右侧，增加两个与原生控件视觉一致的 chip：

| 控件 | 作用 | 默认 |
| --- | --- | --- |
| **角色** | 选择本轮对话的 agent 角色，角色说明会被注入该系统提示词 | 通用助手（不注入额外指令） |
| **GitHub** | 决定任务产出是否发布到一个**新建**仓库 | **每次新建仓库** |

两个选择都是**按会话**生效：改完立刻写入 Host，并从下一步模型请求开始进入系统提示词；对话历史里不会留下任何可见消息。

## 使用

- **角色**：点开下拉，选一个角色。角色不是人格扮演，而是一段可执行的工作约束（例如「代码工程师」要求先读代码、改动最小、交付前跑测试并如实汇报失败）。
- **GitHub**：
  - `新建仓库`（默认）：提示词会要求任务结束后把成果推到一个新建仓库（owner 与命令见 `GITHUB发布指南.md`），只推最终产物，并在回复里给仓库 URL。
  - `不上传`：只保留在本地工作区。
- 选择会记在浏览器 localStorage（key `dsh.promptHint.v1:<sessionId>`），用于页面加载瞬间先画出上次的选择；随后客户端会向 Host 读取权威状态并校正。Host 侧的状态是内存 Map，**应用重启后每个会话回到默认值**（默认即「通用助手 + 每次新建仓库」，与要求一致）。

## Slash 命令（Host 半，可选的手动入口）

```text
/prompt-hint                       # 查看当前选择
/prompt-hint set <roleId> <new|off>
```

`roleId` 取值见下表或命令报错时的提示。

## 角色目录

| id | 中文 | English |
| --- | --- | --- |
| `general` | 通用助手 | General |
| `coder` | 代码工程师 | Software Engineer |
| `reviewer` | 代码审查 | Code Reviewer |
| `writer` | 中文写作 | Writing Editor |
| `researcher` | 调研分析 | Research Analyst |
| `teacher` | 讲解老师 | Tutor |
| `planner` | 项目经理 | Project Planner |
| `designer` | 视觉设计 | Visual Designer |
| `data` | 数据分析 | Data Analyst |
| `video` | 视频创作者 | Video Creator |

角色正文在 `roles.js`（Host 侧唯一真源）；`client.js` 只保存 id 与显示文案。新增角色要同时改两处，id 必须保持稳定（客户端 localStorage 里存的就是 id）。

## 实现

```
dsh-prompt-hint/
├── package.json        # bundle manifest：dsh.bundle.patch + dsh.client.inject
├── cordis.patch.yml    # 把 id=prompt-hint 的插件行插入宿主组合
├── index.js            # Host 半：会话选择 + 一段 systemPrompt.section + 同源 HTTP 路由 + /prompt-hint 命令
├── roles.js            # 角色目录（id / 显示名 / 注入的 prompt 正文）
├── client.js           # Client 半：__ModuleLoader__ 懒工厂，注册 conversation.hero.options 插槽
├── locale/{zh,en}.json # 插件自身的展示名与描述（插件管理页用）
└── icon.svg            # 自绘图标（两个提示 chip + 上传箭头）
```

**Host 半**（`index.js`）

- `inject = ['systemPrompt', 'commands', 'webServer']`。
- 用 `ctx.systemPrompt.section({ name: 'prompt-hint:guidance', order: 800, text: (assembly) => … })` 注册**一段全局 section**。`text` 是函数，每次组装时按 `assembly.agent.session` 取该会话的选择，所以中途换角色不需要重新注册（这是 `@deepseek-ai/dsh-plan-mode` 的既有写法）。文本函数整体包在 try/catch 里，异常只让本段为空，不会炸掉整次组装。
- 选择存在内存 `Map<sessionId, {role, github}>` 里（上限 256 条，FIFO 淘汰）。**默认值不随任何会话的选择漂移**：没有自己选择的会话（包括全新会话）永远用配置里的默认值，所以「每次新建仓库」是真默认值，不会因为别的会话点过「不上传」而失效。
- 状态传输走**同源 HTTP 路由** `POST /prompt-hint/api/{state,set}`（`ctx.webServer.register({kind:'prefix'})`，挂在宿主自己监听的端口上）：`state` 返回 `{role, github, roles:[…]}`，`set` 接受 `{sessionId, role?, github?}`。路由只接受 POST + JSON、拒绝跨 Origin、body 上限 64KiB、`cache-control: no-store`。
- 为什么不用 session command：`commands.execute()` 会把 `command/run` 与 `command/done` 写进会话日志，聊天流里会留下持久节点；每次挂载同步状态就会污染每个会话。HTTP 路由不碰会话日志。
- `/prompt-hint` 命令保留为手动/诊断入口（`/prompt-hint` 查看、`/prompt-hint set <roleId> <new|off>` 设置），客户端不再调用它。

**Client 半**（`client.js`）

- `window.__ModuleLoader__.load({ id: '@local/dsh-prompt-hint', factory(require) { … } })`，只用 `require('react')` 与（可选的）`require('@deepseek-ai/dsh-client-ui-primitives')` 取 `Menu` 和图标；两条 chip 的 DOM 与 CSS 是照抄模式选择 chip 的 seat 规则（同样的主题 token、13px/500、28px 高、hover 底色）。
- 挂在 `conversation.hero.options` 这个 **list 插槽**上（新任务行里工作区、模式选择之后、右对齐的那块），`inject: (sessionId) => ({ sessionId })`。
- 加载：先画 localStorage 缓存 → `POST …/state` 拿权威选择并校正、用返回的 `roles` 建菜单 → 写缓存；请求失败只 console.warn 并退回内置兜底目录，不阻塞页面。
- 改选：乐观更新 → `POST …/set` → 成功用返回值校正；失败回滚到上一次成功状态并把 Host 的错误文案显示在 chip 右侧。用单调序号丢弃晚到的响应，避免连点时旧响应覆盖新选择。
- 若 primitives 的 `Menu` 不可用，退回内置的 `SimpleMenu`（绝对定位、点外部/Escape 关闭），保证控件始终可用。

## 已知限制

1. **只在新任务页出现**。已开始的会话没有 hero 行，因此看不到这两个 chip；此时可用 `/prompt-hint` 命令设置。
2. **状态不写会话日志**：Host 侧是内存 Map，应用重启后各会话回到默认值（默认本身就是「通用助手 + 每次新建仓库」）。
3. 角色正文与 GitHub 交付指令会**进入每一次模型请求**的系统提示词（属于设计意图），角色文本请保持简短。
4. 视觉对照是用源码逐条复制 CSS 得到的，**没有在浏览器里做像素级比对**（本环境没有浏览器控制能力）；实际渲染效果需人工确认一次。

## 安装与验证

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

已在本机安装并验证（不是推测）：

- `install_bundle` → `application:"applied"`, `warnings:[]`；profile 的 `node_modules/@local/dsh-prompt-hint` 是指向本目录的 Junction，改本目录文件即改生效文件。
- Host 半热更新：改完 `index.js` 后 `plugin_manager set_plugin(target="include:prompt-hint", enabled=false → true)` 触发 profile 重组并替换已改动的模块（不必重启应用）。
- 路由实测（`http://127.0.0.1:28602`）：`state`/`set` 均 200 且返回 10 个角色；`role:"nope"` → 400 `invalid-role`；`github:"maybe"` → 400 `invalid-github`；坏 JSON → 400 `bad-json`；GET → 405；未知方法 → 404；跨 Origin → 403。
- 系统提示词实测：新起一个只读自检 subagent，它回读到了「【交付与发布】」段落原文，说明 section 真的进入了真实模型请求。
- **浏览器渲染未验证**：本环境拿不到 GUI 的 auth token，也没有浏览器自动化能力。刷新 Web 页面后请人工确认新任务行出现「角色」「新建仓库」两个 chip，且样式与「工作区」「模式选择」一致。

