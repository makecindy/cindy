# Worker 创建弹窗

> 迁自 `DESIGN.md` §4，规范效力不变；迁移时对照现行界面截图补写了 S1–S11（语音按钮、智能路由与插件引擎、模型不可用提示、旧版本远程电脑的降级等）、C3 的权限菜单取交集，并按 #13716 写入关闭按钮，补写内容经主人确认，见 [决策日志](./design-decision-log.md)「2026-11-29 · Worker 创建弹窗」。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动「开启协同」「创建新 Worker」弹窗或手机端的 Worker 表单之前
> **适用路径**：`apps/desktop/src/renderer/features/cc-agent/CreateWorkerPopover.tsx`、`apps/mobile/src/session/ContextSheetCollabView.tsx`

### Worker creation dialog

Desktop `CreateWorkerPopover` serves Start Collaboration and Add Worker with one form: the role
row, the first-task box and More Settings, plus the primary button. A task on an older computer
adds an agent switch between the role row and the first-task box (see Fallbacks below).

- **Header.** The title and the close button share the top row. Close is the shared square icon
  `Button` (`size="sm"`, `variant="secondary"`, `tone="quiet"`) with a localized accessible name
  and `Tip` (§14.6); a −2px margin keeps it inside a 24px slot, so the title row does not grow.
  While its `Tip` is showing, the first Esc closes the tip and the second closes the dialog.
- **Introduction.** Start Collaboration shows one secondary sentence under the title explaining
  that the current task assigns and checks the work while the Worker does it. Add Worker omits it.
- **Roles.** A single-select row of the dialog's existing pill chips answers what the Worker
  does. It starts as Review, Develop and Test — few built-in roles, Review first; roles the user
  adds join the row. Roles are ordered by most recent use and the dialog opens on the first one.
  Selecting a role brings back the task text, model and permission last submitted with it. Roles
  carry no description line. The row label contains the product term Worker and is therefore not
  uppercased.
- **Add role.** The row ends with a 32px round icon chip (plus) with a localized accessible name
  and `Tip` (§14.6). Activating it replaces the chip in place with a pill input for the role name,
  which takes focus; choosing another role restores the plus chip. There is no separate input row
  or hint line.
- **Remove role.** Every role, built-in or user-added, can be removed. The control is an 18px
  round badge on the chip's top-right corner, panel-filled with a 1px border so it masks the chip
  outline. It is hidden at rest and appears only while the pointer is over that chip or keyboard
  focus is inside it (opacity only, `--motion-fast`), so the row never shifts. It has a localized
  accessible name and `Tip` naming the role. Removal always goes through the shared
  `ConfirmDialog`. Removal is lightweight, so its copy stays low-key: it only says the role can be
  added back anytime with Add Role. It does not list or mention what is cleared; no warning tone,
  no destructive button. When the task runs on another computer and that computer's role list
  cannot be read, roles cannot be removed and no badge appears.
- **First task with permission, model and voice.** One 12px container holds a frameless textarea
  and, below it, one toolbar row in the composer's order: the `PermissionSelector` chip trigger on
  the left; the standard `ModelSelector` toolbar trigger and the shared 30px round
  `VoiceInputButton` on the right. A voice-input error shows under the container
  (`FieldVoiceInputNotice`). The dialog is modal, so the permission chip opens an anchored menu
  inside the dialog (`useMorphPopover={false}`); the morphing menu mounts outside the dialog, where
  it cannot be clicked. The container border takes `--text-secondary` only while the textarea has
  focus. There are no separate Model or Permission field labels; the permission keeps its label as
  the accessible context.
- **Model picker.** The trigger opens the composer's full model picker: provider sources, smart
  routes (model groups) and, for a task on this computer, plugin engines. A chosen smart route
  shows its name with the route mark on the trigger. A chosen plugin engine limits the permission
  menu to the modes that both the engine and Worker creation allow — the intersection of the two
  lists — so the menu can show a single mode. When the Worker's agent runs on another computer,
  the trigger shows that provider's mark with the remote-signal ripple.
- **Model problems.** When the model or source saved for the selected role is no longer
  available, a red alert icon sits before the model trigger and an `ErrorNotice` under the
  first-task box says 「上次选择的模型或来源当前不可用。」 with a 「重新选择模型」 button that opens the
  picker; the primary button stays disabled until a usable model is chosen. When this computer has
  no usable model for the agent, a red line under the first-task box says so. Neither appears
  while a smart route or plugin engine is selected.
- **More Settings.** Project and execution device sit in a frameless text disclosure that reuses
  the Provider dialog disclosure treatment ([provider-settings-ui.md](./provider-settings-ui.md):
  left chevron, 13px/500 section title color, minimum 32px hit height, pill focus ring, 20px
  indent). While collapsed, the row shows the current values in tertiary text. It opens by itself
  when a field inside needs the user (project directory missing or unreadable, invalid folder on
  another computer) and cannot be collapsed while that lasts. The expanded state is not remembered
  between openings. Inside, the project field picks the project, shows the repository and branch
  the Worker shares with the Lead, and offers a checkbox to create a new worktree for the Worker;
  the execution device is a select of this computer and the user's other computers. Choosing
  another computer adds that computer's working directory: the chat folder or a folder path, with
  a folder picker. The execution-device label uses the small uppercase label style; a label that
  contains a user-given name, such as 「Mac Studio 上的工作目录」, keeps its own case.
- **New-task draft.** When collaboration starts from a new-task draft, the form has no Project
  field — More Settings appears only when other execution devices are available — and the role's
  built-in starter task is omitted (task text remembered from a previous submission for that role
  still pre-fills).
- **Fallbacks on another computer.** When the task's computer runs an older Cindy that does not
  share its provider list, a Claude / Codex / Pi segmented switch appears between the role row and
  the first-task box, and the Fast toggle moves onto the toolbar. When that computer does not
  support Worker permission modes, the toolbar has no permission button; in Start Collaboration, a
  red line under the first-task box says 「远程设备的版本过旧，暂不支持协同」 and the primary button
  stays disabled, while adding a Worker to an existing remote team omits the error line and keeps
  the primary button enabled for compatibility.

Initial focus goes to the first-task textarea, the form's primary input; choosing Custom moves
focus to the role-name input. Tab containment, Esc, focus return and the blocked dismissal during
creation are unchanged. Light and Dark use existing semantic tokens only.

Mobile shows the same form in the "+" panel (`OrcaWorkerFormView`), rules in
`apps/mobile/docs/mobile-design-guide.md` §4: one card with the role chips, the first task, and a
toolbar row in the same order. On the phone the permission shrinks to the composer's icon-only
button and roles are removed by touch and hold.
