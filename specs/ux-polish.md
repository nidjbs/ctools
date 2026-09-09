# 交互打磨（UX polish）—— 就地确认 / 复制反馈 / 隐私设置 / 首启引导 / 文件动作 / 多行输入 / 模板管理

状态：定稿（2026-09）。范围：P1 各小项 + P0 遗留项，逐项独立可测。按 spec→test→impl 落地。

---

## §1 Chat 内 quick 命令确认就地完成（P0 #2）

**现状问题**：Chat 里选中 quick 命令若需确认，只提示「请到 Launcher 执行」——断流。
**行为**：
- Chat 渲染一条与工具在环批准同构的**就地批准条**（`.approve-box` 同款，tool 名用命令 id，message 用 `CommandResult.confirm.message`）。
- 「批准执行」→ `commands:confirm(id, input)`（`confirmApproved: true` 重放，现成 IPC）→ 结果显示为 `cmd-out`；「拒绝」→ 关闭，不执行。
- 与现有工具 `approval` 态互斥：任一方出现时另一方不可再弹（同一时刻只一种确认 UI）。
- 不改变两段 confirm 的安全闸门：命令侧 `confirmApproved` 语义、越界/策略判定全部不变。
- **失败语义**：confirm 命令抛错 → notice 展示，就地条关闭。

---

## §2 复制反馈 + text 结果可复制（P0 #4）

**现状问题**：Launcher list 点击复制无任何反馈；text 结果没有复制按钮。
**行为**：
- Launcher 全局 `toast`（"已复制 ✓"，1.2s 消失）；list 条目点击复制 → 出 toast。
- text 结果头部加复制钮（复用 `CopyButton` 的"已复制 ✓"反馈）；列表项 hover 高亮不变。
- 不吞原有错误文案（红字「执行失败」语义不动）。

---

## §3 clipboardLocalAlias 进 Settings（P1 #5）

**现状问题**：隐私关键配置（剪贴板只走本地模型的别名）没有 UI 入口，save() 也不回传该字段。
**行为**：
- Settings「网关与模型」grid 加「剪贴板本地模型别名」输入（`datalist` 复用 models），附灰字说明：**留空则剪贴板召回退回默认/远端模型，不推荐**。
- `save()` 的 update patch 补 `clipboardLocalAlias: cfg.clipboardLocalAlias?.trim()`。
- **失败语义**：只 trim，不改默认语义（config 合并仍以 patch 覆盖，空串即显式清空→走远端回退，与 README 隐私承诺一致）。

---

## §4 首启连接引导（P1 #6）

**现状问题**：gateway 未连时用户毫无线索，直到执行才见红字。
**行为**：
- Launcher 空输入首页：mount 与每次 `onLauncherShow` 都 `gateway.status()`；`stopped` 且输入为空 → 顶部渲染可关闭引导条「模型网关未连接，命令/对话不可用」+「打开设置」按钮（现成 `window.openSettings`）。
- 「✕」关闭后本次运行不再弹（组件内状态），下次唤起仍可能弹（状态未连）。
- 引导条出现不吞真实错误：红字错误照常；`gateway.status()` 失败静默（视为 stopped 但可点设置自查）。

---

## §5 文件「Finder 显示 / 打开」（P1 #7）

**设计决策（用户拍板）**：单击复制为主；聚焦/悬停条目浮两个次要动作。
**行为**：
- `CommandResult.list.items[]` 增可选 `path`；`file_list` / `find_file` 为每个 item 填该路径的绝对路径。
- Launcher 结果列表项带 `path` 且为当前 hover（onMouseEnter）项 → 行尾浮「Finder」「打开」图标按钮：
  - Finder → IPC 越界校验后 `open -R <path>`（Finder 定位）。
  - 打开 → IPC 越界校验后 `open <path>`。
- **安全**：越界判定在 IPC 层用 `checkInside(ctx.config.fileRoots, path)`（复用 filePolicy；依赖当前 fileRoots），越界返回 false、不动系统。命令模块不重复判。
- **失败语义**：`open` 命令失败/文件已删 → 静默（或 toast 兜底），不崩 UI。

---

## §6 Chat 多行输入（P1 #8）

**现状问题**：单行 `<input>`，长文本/多行粘贴体验差。
**行为**：
- 单行 input 换 `textarea`：自适应增高（输入时 `height = scrollHeight`，上限 ~6 行出滚动）。
- Enter 发送；Shift+Enter 换行。有候选时 ArrowDown/Up 导航候选（不移动光标行），无候选时回到文本光标编辑（textarea 默认）。
- Esc 仍收起窗口；停止/草稿态等禁用语义不变。
- **注意**：textarea 的 Enter 默认换行——需阻止默认并走 send；ArrowDown/Up 有候选时 preventDefault。
- 输入为空时回车不发送（现状）。

---

## §7 保存模板可管理（P1 #9）

**现状问题**：`/save` 沉淀的 ⭐ 模板无法删除。
**行为**：
- `saves:remove(id)`：按 slug 精确删；不存在 id 幂等（不报错）。删后 Launcher 空态即时刷新。
- Launcher 首页只对 `/save` 沉淀的 ⭐（来自 `saves.list`，区别于内置 `TEMPLATES`）在 hover/选中显示行尾「✕」。
- 「✕」单击 → 该行变成「确认删除？」（再点执行删除 / 移开/失焦取消）。内建模板永不显示 ✕。
- **失败语义**：remove IPC 失败 → 静默 + 刷新兜底。

---

## 通用约束

- 全走既有类型化 IPC；不改命令安全模型、不改 confirm 闸门、不新增默认网络/外传路径。
- UI 文案中文；改动逻辑补单测，改动渲染/流程补 UI e2e（tests/ui/polish.spec.ts）。
