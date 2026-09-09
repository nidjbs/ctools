# file 工具 — 行为契约

> 阶段划分：Phase 1 = 只读（read/list，可放开 agent）；Phase 2 = 写/删（write/rm，**通用两段 confirm**，非 agentTool）。

## 触发

- Launcher：`file_read <路径>` / `file_list [路径]`（alias：read/读取/读文件、ls/dir/列出）回车。
- Agent：作为 `agentTool` 工具由模型按 schema `{ path }` 调用。

## 路径解析与权限（file_roots 强校验）

- 输入：绝对路径，或相对路径（相对 `file_roots` 中第一个能容纳它的根）。
- 校验分两层：
  - 词法（纯函数 `shared/filePolicy.ts` `checkInside`）：`resolve` 后必须仍落在某个配置根内（`根/` 前缀），挡 `..` 穿越。
  - **realpath 守卫（`src/main/pathGuard.ts` `realInside`）**：所有真正触碰磁盘的入口（read/list/write/rm、system reveal/open）再校验目标「最深已存在祖先 + 目标自身」的 realpath 仍落回根的 realpath 内——中间任何 symlink 目录把路径带出根、或目标自身是指向根外的 symlink，一律拒绝。写入不存在的目标按最深存在祖先锚定。
- file_roots 为空时所有读都拒绝。

## 输入 / 输出

### `file_read`
- 输出：文件 UTF-8 文本；超过 256 KB 截断并标注总长；空文件返回 `(空文件)`。
- 失败：路径越界 → `拒绝：路径不在 file_roots 内…`；不存在/不可读 → `读取失败: <原因>`。

### `file_list`
- 输出：`list` 结果，条目标题 `📁/📄 名称`，copy 为完整路径（每项限前 50）。
- 失败同上（越界拒绝 / 读取失败）。

## Phase 2：写 / 删（两段 confirm）

### `file_write`（非 agentTool）
- 输入：`file_write <路径> <内容>`（首 token 路径，其余为内容），或 agent 风格 `{ path, content }`（但不会进 agent 工具）。
- 目标已存在 → `overwrite`；不存在 → `create`。成功返回 `已写入/已覆盖 <p>`。

### `file_rm`（非 agentTool）
- 输入：路径字符串（相对或绝对）。成功返回 `已删除 <p>`；不存在返回 `文件不存在`。

### confirm 语义（纯函数 `needConfirm`，spec 契约）
- `never` → 永不确认；`always` → 一切写/删都确认；`auto` → 仅破坏性确认（`delete`、`overwrite` 且已存在）。
- 需要确认且 `ctx.confirmApproved` 未设 → 返回 `{type:'confirm', message}`；Launcher 展示 确认执行/取消。
- 用户确认 → IPC `commands.confirm(id, input)`：主进程以 `{...ctx, confirmApproved:true}` 重放 `registry.run`，命令放行执行。
- 拒绝越界校验：与 Phase 1 相同（file_roots 内）；写目录不存在 → `写入失败`。

## 安全约束

- Phase 1 只读命令进 agent（可放开）。
- Phase 2 写/删命令也进 agent（`agentTool=true`），但**破坏性操作恒需确认**：agent 分发遇 confirm → Chat 内人工批准（`onConfirm`）→ 批准后以 `confirmApproved` 执行；拒绝不落盘。`auto` 下新建/追加 agent 可直接完成（file_roots 内、tool 气泡可见）。
- 越界路径一律拒绝；词法之外的 symlink 目录/文件逃逸由 `realInside` realpath 守卫兜底（2026-09 起，不再是已知边界）。
