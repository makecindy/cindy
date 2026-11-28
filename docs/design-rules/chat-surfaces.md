# 聊天界面

> 迁自 `DESIGN.md` §4、§14.4 与文末无编号章，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动聊天正文、群聊、频道或附件图片在对话里的显示之前
> **适用路径**：`apps/desktop/src/renderer/components/chat/**`、`apps/desktop/src/renderer/features/bots/BotChannelsPage.tsx`、`apps/desktop/src/renderer/features/bots/BotGroupAssistantDeviceCard.tsx`

### Desktop chat and operation authorization

Chat prose and compact code use the existing `chatChrome.ts` presentation entry; activity rows reuse `activityRowChrome.ts`. Keep user/assistant, tool, code, thinking and media theme aliases local. Icon actions use the ordinary pill frame with their contextual targets, visible keyboard focus and a Tip; a hidden message action bar becomes visible when keyboard focus enters it. Media previews and content-clipping cards retain their content geometry under §5. Do not change message identity, streaming, history, Diff Worker/virtualization or media/file lifecycles to share presentation.

**IM context card disclosures (owner-confirmed HTML direction, registered 2026-09-12, #4367):** `HookTaskCard` has two narrowly scoped bare-text controls: long-body expand/collapse and the attached-context disclosure. Both remain frameless in resting, hover and expanded states; group contents also have no background frame. This records the confirmed quiet presentation, not a general exemption for chat actions. Both controls share a minimum 24px hit height/width and 4px vertical padding, retain native button keyboard activation, and use a separate visible `focus-ring` box-shadow ring. Text uses `text-tertiary`, with `text-secondary` on hover, in both modes; context text may wrap. The outer message card retains its existing content-clipping treatment. This registration does not assert real-client visual acceptance; Light/Dark HTML previews are not client screenshots.

**Desktop group member-joined disclosure.** `BotGroupMemberJoinedNotice` (`BotGroupTimelineItem.tsx`) displays one or two names as centered notice text. When three or more names are grouped, the centered summary is a frameless text button that toggles the full list in place. Both states stay frameless at rest and on hover, with `--text-tertiary` at rest and `--text-secondary` on hover. Keyboard focus draws a 2px `--focus-ring` with `rounded-lg` shaping the ring. The button exposes its state through `aria-expanded`.

**Android in-app update card:** moved to the [Mobile design guide §9](../../apps/mobile/docs/mobile-design-guide.md#android-in-app-update-card-owner-approved-html-direction-registered-2026-10-16-6199).

**Desktop Permission decisions, user-approved 2026-09-11 after actual-component comparison:** Allow once remains the visual main action using `perm-allow-*`; deny and session-scoped allow remain secondary. Retain neutral operation information: Desktop has no trusted risk-level field, and `autoReviewUnavailable` is not a risk conclusion. No invented danger variant or command-based risk inference. Keep the request in the composer area with title → description → scrollable operation → right-aligned wrapping actions, at the existing density. Use Button with a narrow local-alias adaptation; apply §5's existing pill-button and keycap treatments. Keep long scoped rules bounded by the column and available in the Tip. Labels, order, shortcuts, IME/editable-focus guards, submitting and failure recovery remain owned by the existing permission flow. This decision does not cover permission mode selectors, account/plugin authorization lifecycles or Mobile layout; Mobile is deferred to its own phase.

### Desktop chat content width

新建任务、进行中的普通任务、伙伴私聊与群聊共用居中的内容列、输入区和本机的「外观 → 聊天布局」偏好。
标准是默认选项，内容列上限为 914px。「宽屏」显示内容宽度滑杆，从扣除左右边距后的实际面板宽度取 50%–100%，
默认 75%，每次调整 5 个百分点。宽裕的面板逐档变化，窄面板优先留足阅读空间并随可用宽度自然收缩。
输入区与内容列同轴居中，每侧向外 10px。右侧面板和分栏仍由现有布局引擎分配空间，消息边距从紧凑的每侧 20px
逐渐过渡到宽裕面板的 50px。
外观页在壁纸下方的「侧边栏与面板」卡片中放置聊天布局。宽屏滑杆、百分比和缩略预览并排，窄窗口随设置行换行。
缩略预览用同一宽度计算及消息、输入卡片。切回标准会保留之前选择的宽屏比例。
偏好随本机桌面普通窗口同步，独立于单条回复的主题阅读宽度。

普通任务的正文、表格与代码共用内容列。伙伴私聊和群聊的消息使用原有按内容收窄的气泡，仍为720px
上限。实际面板达到 1600px 或内容列宽超过标准列宽时，Markdown表格按内容决定列宽，短表格的列保持相邻，长表格仍受消息
或气泡可用空间约束，超出时在表格内横向滚动。用户外观设置的阅读宽度继续约束整条回复。

实现见 `useProportionalWidth.ts`，真实组件几何与明暗回归见 `scripts/fixtures/task-content-width/`
和 `scripts/fixtures/group-width/`。

### Desktop message nav rail preview

提问导航条的悬停预览在首行标出发送者，有发送时间时一并显示。圆角底框只用来标出本人的提问：只有本人提问才放进与用户气泡同色（`--msg-user-bg`）的圆角框。本人身份与聊天来源一致，设备标签只说明发送设备。其他来源沿用聊天的署名和图标，正文使用次级文字色，不得加圆角底框；给所有消息加框就无法一眼认出自己的提问。

### Desktop chat threads

Group and private threads share the same panel chrome, root message row and reply divider. The complete root message belongs to the replies’ scroll container; it has no independent height limit or scrollbar. Keep the header and reply composer visible outside that scrolling content. Private threads retain the ordinary task runtime for progress, approvals and stopping.

### Desktop group progress strip

`BotGroupProgressStrip` is the in-progress entry in the group timeline
([group chat §5](../product-rules/bot-group-chat.md#5-界面)): one left-aligned entry per running
execution, made of the member avatar and the shared `WorkGroupBlock` journal. It has no
capsule or other outer frame; its content and states follow the product rule. Keep semantic
surface/border/text colors in both Light and Dark. It does not authorize pill-shaped toolbars or other status panels.

### Group Cindy waiting-for-a-computer card

`BotGroupAssistantDeviceCard` (Desktop, passed to `BotGroupComposer` as `aboveCard`; Mobile, above the
group composer) is the requester's own prompt for group-Cindy requests held until they choose a computer
([group chat §9](../product-rules/bot-group-chat.md#9-群里的-cindy2026-11-12)). Only that member sees it. It docks above the
composer in the permission request's place and uses the same chrome: `rounded-xl`, 1px
`--chat-input-border`, `--chat-input-bg`, and 16px horizontal / 12px vertical padding. Top row: a 15/500
title, with a 12px `--text-tertiary` 「只有你能看到」 label and an eye-off icon on the right. Below it,
two 13px `--text-secondary` lines: the request (or how many are waiting) and the reminder that later
requests use the same computer. Separate lines are needed because sentence joining differs by language.
Bottom row: a compact `Select` of computers, plus a right-aligned secondary 「取消请求」 and primary
「继续」 that wrap together as one group. Mobile uses the same order with `BotGroupMenu` and two
equal-width compact `MainWindowActionButton`s. When there are no computers, both clients show the
request and the cancel action. Real-component regression:
`scripts/fixtures/group-control` cases `assistant-device-wait` and `assistant-device-wait-narrow`.

### Desktop hidden channel records

`BotChannelsPage` lists each connection's hidden channel tasks. The record name and
summary are one narrowly scoped bare-text control: resting, hover and pressed states
keep the existing text block (12px `--text-primary` name, 11px `--text-tertiary` meta,
no fill, border, radius or added padding). Making that existing text open the ordinary
task page does not assign a pill frame or change task state. The separate restart
action remains the registered compact secondary Button and is outside this exemption.
This records the accepted quiet list, not a general exemption for settings actions.

Keyboard focus uses the theme-invariant `--focus-ring` as a `focus-visible` box-shadow
ring. Non-input `outline` is suppressed globally, so an outline class is not a visible
focus treatment here. The ring appears only for keyboard focus and does not create an
ordinary control frame (§5). The single-page comparison showed no resting-pixel change;
this registration does not claim a new client screenshot of the keyboard ring.

### User-attached long images

Desktop user attachments with natural height / width **strictly greater than 3** use a
240×240 top-aligned partial preview, shrinking to the available container width. A
non-interactive pill overlay says “长图 · 点击查看完整图片” (localized); it uses semantic
surface/text tokens and wraps in narrow containers. The image retains its existing
12px content crop and keyboard/click target. Ordinary portraits, landscape images,
unknown dimensions and tool-output images retain their existing contain rules.
Click/Enter/Space still opens the complete original in ImageLightbox; gallery, copy,
annotations and original bytes remain unchanged. This applies through the shared
Desktop user-attachment renderer in private chats, groups and tasks.
Decision: [#6796, maintainer confirmation](https://github.com/makecindy/cindy/issues/6796#issuecomment-6361112964).

## 流式正文与可组合组件

用户确认的答案方向：正文由流式编辑器与共享组件库承载，模型自由组合图文、图表和交互布局；普通任务与伙伴采用同一能力。每个完整节点增量出现，局部修订保留稳定控件身份和用户操作值。视觉沿现有正文、控件和媒体规范，不以整页 HTML 预览框替代连续正文。两端主题与窄屏同等实现。协议、能力发现与当前验收边界见 [流式正文与可组合组件](../rich-answers.md)。

### 伙伴私聊消息下操作

伙伴私聊同一轮的工作过程区与最终回复共用一个当前伙伴头像，三端一致。
头像在本轮开头显示，右侧依次呈现处理记录与回复正文；执行中转为完成态时保持同组，不再给回复重复头像。
复用回复头像的尺寸、间距和正文列；展开的中间文字与工具明细不重复头像，成果卡仍与正文对齐。没有过程的回复照常显示头像，新一轮重新显示头像。

常用操作固定在消息下方，复用现有群聊图标、引用预览与输入组件。桌面32px按钮、4px间隔、14px图标；手机44pt热区、不额外插空，左右消息的操作图形对齐对应正文边缘。复制/回复/更多常显，现有朗读与编辑能力保留；创建话题与分享图片放更多。已有话题沿用头像、回复数及最后回复时间/未读提示入口，不另造数字徽章。普通任务、伙伴私聊与群聊共用本文件 [Desktop chat content width](#desktop-chat-content-width) 的居中宽度规则，气泡及输入区规则见 [群聊规则](../product-rules/bot-group-chat.md)。手机正文直接选字不受操作栏影响。沿用语义色与原菜单开合、焦点和按压状态；各语言及明暗模式均不得溢出。

### 伙伴内部通讯入口

伙伴间收发只留一行次级文字「已发消息给 X」／「消息来自 X」，复用原小头像与双向箭头的单行胶囊入口，
入口与「处理记录」及助手正文共用左对齐轴，不用两侧伸展分隔线把入口推到中间；
11px 字号、28px 最小点击高度，颜色走现有语义 token，键盘焦点可见。
不铺两行摘要、不另放展开/完整对话按钮。点击直接打开原只读往来页，返回原主任务位置。
长名字在可用宽度内省略，完整标签保留在可访问名称和悬停提示。手机沿用已有触摸热区。
内部往来不制造用户未读；执行与提醒边界见 `cindy-bots-runtime.md` §6.1。
2026-11-08 起伙伴私信已移除（伙伴之间改用 `send_to_session`），不再产生新入口；历史入口照常打开只读往来页。

### Stream pacing

- **Stream pacing(流式匀速放出, 2026-11-25)**: arrived text is not rendered batch-by-batch. `useStreamingReveal` (`components/chat/streamingReveal.ts`) sits in `MarkdownRenderer` between the received text and the rendered prefix. **Rate follows backlog**: rate = backlog ÷ target lag. The lag adapts between 120ms and 600ms to the arrival gap (×1.25) and to backlog ÷ max(600 chars/s, measured arrival rate × 1.25), so a single burst is spread out while sustained fast output stays ≈120ms behind.
  Benchmark tiers: slow ≈60, steady ≈160, long ≈600, fast ≈1500 and turbo ≈4000 chars/s. **Cuts only at word, punctuation or CJK-character boundaries**, and table rows appear whole, so this is still not a typewriter. **Paces on animation frames but renders as its own React task** (never `flushSync` inside the frame: stacking the subtree render onto the frame's layout/paint measured +40–70ms on the longest task).
  The interval backs off from the larger of two measurements: the subtree's own render cost (render start → commit) × 4, and main-thread busyness (requestAnimationFrame delay beyond 20ms × 4). It stays between 33ms and 400ms, and is at least 50ms while the composer is typing (typing-first). The switch to the final render happens in the stream-ending render itself, or in a normal task after the drain.
  It never flips final → streaming → final within one commit; that flip measured a single ~230ms long task. When the stream ends, any remaining backlog is drained within 150ms (`STREAM_REVEAL_END_DRAIN_MS`) while still rendering in streaming mode, then the final render replaces it. Shows everything at once when: the text is rewritten rather than appended, the window is hidden (100ms timer, no animation), or Reply motion is off / reduced motion is on (no buffering; cadence only).
  Text already present at mount is shown immediately, never replayed. Copy, search and navigation read the full text, never the revealed prefix. **Red lines**: no fixed time throttle in front of or behind the reveal (the former 100–400ms length-bucket `useStreamingThrottle` measured ≈9 visible updates/s and 300-char jumps); backoff must come from measured render cost, not text length.
  Guards: `__tests__/streamingReveal.test.tsx` (unit) and the black-box budget run `node apps/desktop/scripts/streaming-smoothness.e2e.mjs --label <name> --assert`. That run uses an isolated `--mock` Desktop and a loopback model, and covers seven scenarios: slow / steady / bursty / long / typing / fast / turbo.
  Run it before and after any change to this path, then use `--compare <before> <after>` or `--check <report>`. The 2026-11-25 baseline fails 11 budgets. Its budgets are smoothness floors plus no-regression ceilings for long tasks and typing latency.
