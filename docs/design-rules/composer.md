# 输入框的发送与停止按钮

> 迁自 `DESIGN.md` §2、§14.4，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动输入框的发送 / 停止按钮、工作中光晕或伙伴私聊输入框的通话按钮之前
> **适用路径**：`apps/desktop/src/renderer/components/new-chat/SendButton.tsx`

### Working glow colors

- **Composer Stop working glow (owner-approved 2026-11-18, Design Lab send-button v5)** — while an AI turn runs, the Desktop composer Stop button (`SendButton`, `.composer-send-beam` in `globals.css`) carries a rainbow beam around its edge, ported from the open-source border-beam (MIT) small size: eight hues (green `#32C850`, teal `#1EB9AA`, orange `#FF7828`, violet `#6446FF`, pink `#F032B4`, purple `#B428F0`, blue `#288CFF`, red `#FF3264`) plus a white highlight on the dark Light-mode disc and a black one on the light Dark-mode disc. It means only “the AI is working”; it never appears on Send, idle, disabled or any other control, and the rest of the button stays neutral-inverse. Motion: [Composer motion](#composer-motion) below and the Composer Stop working glow row in [exceptions/motion.md](./exceptions/motion.md#registered-looping-indicators).

### Working glow gradients

- **Composer Stop working glow** — the rim, inner glow and bloom of the registered working glow ([working glow colors](#working-glow-colors) above; motion in [exceptions/motion.md](./exceptions/motion.md#registered-looping-indicators)) use radial and conic gradients clipped to the 30px Stop button; masks inside it are alpha-only. Not a surface treatment for anything else.

### Composer motion

**Desktop companion composer action.** An idle
one-to-one companion composer shows dictation and a call action. A visible prompt
recommendation keeps the call action available; its
Tab/click acceptance and Enter send remain available. An accepted or typed draft,
attachments or browser comments replace the call with Send in the same 30px circular
target. Crossfade the icon layers and scale 55% ↔ 100% on
`--motion-enter` (250ms) / `--motion-ease-move`; keep the shell, hit target and dictation
position fixed, with no bounce. CSS transitions retarget from their current values.
Respect reduced motion, retain keyboard focus, and reject a press whose action changes
before activation. Recording/refinement, Stop, Queue and queue editing retain their
existing actions. Other composers keep their existing behavior.

**Desktop composer send / stop (owner-approved 2026-11-18, Design Lab send-button v2–v5).**
`SendButton` (every composer, plan feedback and group chat) is a 30px circle like the dictation
button beside it; with nothing to send it keeps the neutral-inverse fill at 40% opacity and fades
to full over `--motion-fast` when the draft becomes sendable. Press retracts only the fill by 1px
(§4 Button feedback). Send → Stop: the paper plane flies out up-right (`--motion-fast`,
ease-in) and the 10px square lands from 55% after `--motion-instant` (`--motion-enter`,
ease-move); the working glow then fades in. When the turn ends or Stop is pressed, the square
leaves first, the plane glides back from the lower left after `--motion-instant`
(`--motion-enter`, ease-out), the glow keeps turning while it fades out, and only then does an
empty composer dim back to 40% (delayed by `--motion-enter`). The main slot keeps one mounted
button for send, stop and call so these transitions can play and focus survives. A secondary
Stop opens from zero width (`--motion-base`) without moving dictation or Send. While a
dictation long-press hovers Send as its release target, Send scales to 106% with a 1.5px
`--text-secondary` ring. The dictation button records with three `--settings-badge-error` level
bars and a timer. On recording start the bars ripple once (except in reduced motion), then settle
at the quiet baseline. Live microphone levels (40 ms windows) take over as soon as sound arrives; its width uses `--motion-base` / ease-move and the
mic, bars and refining spinner cross-fade (`--motion-fast`); busy states are not dimmed.
All motion lives in `globals.css` (`.composer-send*`) on motion tokens; reduced motion switches
instantly and keeps the glow still.
