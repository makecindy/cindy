# Desktop 手写弹窗 Radix 迁移证据

日期：2026-10-05。平台：macOS arm64 / 真实 Electron Desktop，1280 × 800 CSS px，DPR 2。
基线：`24551276ff345b980533ba1c89274c6bb890b28d`（开工时最新 origin/main）。候选：`fix/desktop-handwritten-dialogs-radix` 上的补丁；最终提交 SHA 记录于草稿 PR 正文。

## 逐项评估与行为对照

| 对象 / 决定 | 迁移前：焦点、Tab、Esc、关闭与保存 | 迁移后与保留方式 |
| --- | --- | --- |
| AddProviderWizard / Dialog | 无统一初始焦点、Tab 限制或回焦；window Esc（保护 IME / keyCode 229）关闭整个向导；遮罩不关闭；实际保存用 savingRef 阻止取消和 Esc，授权取消走原 cancelAuthorize | 用户批准补齐：目录聚焦搜索，直达表单首个 input，无输入时首按钮；Radix 限制 Tab、最上层 Esc，IME / 保存门保留；退场后再 onClose / onDone / onOpenCustomForm，并回到原打开控件。 |
| ProviderConnectionDialog 主表单 / Dialog | 首个 input，手写 Tab 循环，卸载回到 opener 或 returnFocusRef；window capture 唯一 Esc owner：图片中断确认 → 帮助 → runtimeFill / childLayer → 主表单；保护 IME / 已消费事件 / saving；遮罩不关闭，实际保存期间取消不能关；独立模型获取不锁表单 | 保留首个 input 与 returnFocusRef，Radix 接管 Tab / Presence / 回焦；保留原 window capture owner，主 Content 阻止 Radix 二次消费 Esc；子弹层、图片确认、测试连接和模型获取原样。实际保存成功待退场后再 onSaved，失败恢复原表单。 |
| MermaidSourceEditor / Dialog | textarea 获焦、光标 0；无 Tab 限制 / 回焦；window Esc 和取消直接放弃草稿；dirty 控制保存 / Cmd+Enter，未修改时快捷键取消；遮罩不关闭；isVisible / RAF / 200ms timer 手写退场 | 保留 textarea / 光标、dirty / Cmd+Enter、body.dataset.mermaidEditorOpen 和取消语义；用户批准 Tab / 回焦与最上层 Esc；Presence 取代手写动画与计时，退场后保存 / 取消。原源码没有放弃修改二次确认，本次也不添加。保存退场后同步交给 applyEdit，无独立异步保存态。 |
| CreateWorkerPopover / Dialog | 无初始焦点 / Tab 限制 / 回焦 / Esc owner；遮罩不关闭；× 在 onCreate promise 未完成时仍可关闭 | 用户批准角色 input 初始焦点、Tab / 最上层 Esc / 回焦，以及创建时禁止 × / Esc；失败后恢复。3 个生产调用点：OrcaWorkerPanel / CCAgentSessionView / NewMakerDraftRoute，均不传 className；入参留在 Overlay 原 shell。从 + 菜单打开时，菜单本来先回焦到编辑框，弹窗记录并归还该焦点；直接按钮入口归还按钮。 |
| BrowserTabBody 崩溃提示 / 保留手写 | 标签页 slot 内 absolute 覆盖；无自动获焦 / Tab trap / Esc / 关闭回焦；重新加载或强制终止是恢复动作，无保存态 | 不是整窗模态。Radix 会错误锁定整个窗口焦点和滚动，所以不迁移；源码不变，HAND_BUILT_DIALOGS 仅保留该项并说明原因。 |
| GhostCardLinkConfirm / AlertDialog | 取消 autoFocus；仅面板内 Esc 取消；BlockingScrim 阻止外部点击、不关闭；无 Tab trap / 回焦；打开与取消是同步结算，无保存态 | 保留取消初始焦点、按钮顺序和业务语义；用户批准 Tab / 最上层 Esc / 回焦；Cancel asChild + Presence，退出后结算一次。GhostCardPromptPanel / BlockingScrim 输入浮层保持原样。 |

上述焦点补齐、最上层 Esc，以及 Worker 创建中关闭保护已在实现前得到用户确认。未调整外观、文案、业务提交参数或其他弹窗。

## 规范与结构

- DESIGN.md §4 Dialog & Modal：Overlay / Container 只复用 `.modal-scrim` / `.modal-panel`；保留宽度、层级、内边距与布局。Focus on open 保持原首输入 / Cancel；Closing affordance：每个 Dialog.Content 无条件 preventDefault onPointerDownOutside，AlertDialog 保留内建外部点击保护。
- DESIGN.md §14.2 / §14.4 heavy overlay：共享关闭状态与 Radix Presence，不添加独立动效或计时器；开场 250ms、退场 150ms。减弱动效由既有 CSS / Presence 决定。
- design-governance.md §6：真实客户端 Light / Dark 截图与 computed；§10 D5：只在真正保存期间禁止关闭，不锁连接测试 / 获取模型。
- windowDrag.tsx：Overlay 在前、WINDOW_DRAG_STYLE，Content 在后、WINDOW_NO_DRAG_STYLE；中心定位使用 inset-0 + margin auto，避免 transform 居中导致 Electron no-drag 打孔偏位。Worker Content 在 Overlay 内，保留 className 的 shell 语义。
- useDialogExit 只协调父级会立即卸载的弹窗：以 onCloseAutoFocus 的 Presence 生命周期回焦并结算 callback，不另造 timer / CSS / 弹窗 primitive。

## 实机对照

采用用户指定 `--region=cn --isolated=@worktree`；启动日志 `DESKTOP_DEV_VERDICT=ready`，desktop:whoami 确认独立 profile。未修改主仓未提交内容，未保存供应商、创建 Worker 或发送外链。
基线截图是在同一 worktree 暂时装载 base 原版 5 个生产组件补采，之后恢复全部候选源码；全局样式与依赖相同。这是实际 Electron 生产组件渲染。

Light / Dark 各 5 个弹窗、共 10 组 before / after：panel / scrim 的 x、y、width、height、background、border、borderRadius、shadow、padding、color 逐值一致。未宣称逐像素完全相同：新增焦点保障按批准落点呈现焦点态，背景内容可能动态变化。

| 面板 | x, y（CSS px） | width × height（CSS px） | padding |
| --- | --- | --- | --- |
| wizard | 340, 80 | 600 × 640 | 0px |
| provider | 340, 48 | 600 × 704 | 0px |
| worker | 390, 131.5 | 500 × 537 | 24px |
| ghost | 480, 323.5625 | 320 × 152.875 | 14px |
| mermaid | 200, 80 | 880 × 640 | 0px |

所有面板圆角 12px。Light：背景 `rgb(253, 253, 248)`，边框 `1px solid rgb(228, 228, 223)`，阴影 `rgba(0, 0, 0, 0.15) 0px 4px 16px 0px`，遮罩 `rgba(0, 0, 0, 0.5)`。Dark：背景 `rgb(31, 31, 31)`，边框 `1px solid rgb(49, 49, 49)`，阴影 `rgba(0, 0, 0, 0.5) 0px 4px 16px 0px`，遮罩 `rgba(0, 0, 0, 0.7)`。遮罩均 1280 × 800、无圆角与阴影。这些是实测值，不是新增 token。

5 个弹窗两主题均实际读到 open 的 modal-scrim-in / modal-panel-in（0.25s），closed 的 modal-fade-out（0.15s），Presence 留到退场完成再卸载。窗口后台 Chromium 暂停动画时，采集计算值并推进实际 CSS Animation.finish()，切到前台复核完成，不派发伪造动画事件。Ghost 原 modal-panel-in-centered 转为共享 modal-panel-in，静止中心位置不变。

执行者已目检上述 10 张候选截图，尺寸、布局、浅深主题与初始焦点正常。另以 CDP 鼠标 / Tab / Escape 复核 5 个弹窗的初始焦点、连续 Tab 不离开面板及关闭回焦；Worker 角色说明 Tip 是最上层，Esc 先关闭它，Tip 退场后 Esc 才关闭主面板。

## 自动验证与缺口

- `pnpm --filter desktop run --if-present typecheck`：通过。
- `pnpm test:unit:related`：通过；新增 / 更新焦点、双向 Tab、Esc 层级、实际保存 / 创建期间关闭门、回焦、Mermaid 草稿与真实 Radix Presence 生命周期测试；cardShortcutYield 回归通过；dialogScrimDismissal 单独运行，6 项通过。
- `pnpm check:design-colors --worktree` / `pnpm check:design-inventory` / `pnpm check:dev-docs` / `git diff --check`：通过。未改守卫门槛。
- Windows 实机未验证：本机 macOS；no-drag 几何、系统窗口行为与无 blur 回退等待 Windows 复核。
- 向导 / 供应商 / Worker 来自真实业务入口；Ghost / Mermaid 是真实 Electron 中临时挂载生产组件的测试入口，未跑完整插件 iframe 外链与 CodeMirror 文件编辑端到端路径。保存 / 创建成功失败门由可控 promise 单测覆盖，未做真实账号 mutation。
- 截图 / JSON 本地目录 `artifacts/handwritten-dialogs`（Git 忽略），文件名 `{wizard,provider,worker,ghost,mermaid}-{light,dark}-{before,after}.{png,json}`；动画审计 `animation-audit.json`，键盘 / 回焦 `focus-real.json`。未提交截图、运行日志或测试替身。
- 20 张公开图片已上传为 [cindy-fork Release 证据附件](https://github.com/kirozeng/cindy-fork/releases/tag/pr-5491-ui-evidence)，并嵌入 [PR #5491 描述](https://github.com/makecindy/cindy/pull/5491)：每个弹窗均有 Light / Dark × before / after。PNG 不进入代码提交历史；这是截图证据存储页，不是客户端版本发布。使用既有 GitHub CLI 登录上传 Release assets，无需网页登录。

## 提交后复检（2026-10-05）

- 简洁度检查删除 Ghost Cancel 上重复的手动 onClick，统一经 Radix Cancel → Root onOpenChange → useDialogExit 结算；取消 / Esc / 打开仍各只结算一次。清理测试的无用变量和无用 async suite 声明，不更改测试断言。
- 重新运行 design-colors（包含实际 worktree）、design-inventory（52 surface）、dev-docs（10 项）：通过。颜色 unexpected=0，报告项是既有表单采用提示与本证据实测 RGB 记录。
- 清理后 Desktop typecheck 与 test:unit:related（40.1s）通过，git diff --check 通过。
- 截图仍对应 `0ff0d015767491884ed2c2759233ed5c7c639e72`；本次清理只去掉重复处理，无外观变化。
