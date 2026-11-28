# 设置里的单页

> 迁自 `DESIGN.md` §4，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动设备访问胶囊、伙伴模型与能力页或「关于」里的 harness 版本之前
> **适用路径**：`apps/desktop/src/renderer/components/settings/MyDevicesPanel.tsx`、`apps/desktop/src/renderer/components/settings/CloudComputerRow.tsx`、`apps/desktop/src/renderer/components/settings/HarnessVersionMenuRow.tsx`、`apps/desktop/src/renderer/features/bots/BotCapabilitySettings.tsx`、`apps/desktop/src/renderer/features/bots/BotModelChainEditor.tsx`

### Device access pills

Settings → Remote Connection → My devices shows what each other device may do as two rows split by direction, not as a stack of switches (owner decision, 2026-11-03, unified authorization direction B): “I can” holds the outbound pill (Control it), “It can” holds what that device may do with this computer (Control this device; later Sync keys and Use models on this computer join the same row). The row label is 12px `--text-secondary` in a `max-content` column; pills are 28px-tall full-radius buttons with 12px text. Pressed = `--surface-chip` fill, no border, 12px check icon, `--text-primary`; not pressed = 1px `--border-default` outline, `--text-tertiary`, hover `--surface-hover`; disabled = 40% opacity. A pill is a `button` with `aria-pressed` and keeps the per-device accessible name of the switch it replaced; a click applies immediately with no confirmation. A reason line (11px `--text-tertiary`) sits under the pills of its row. Devices that cannot be controlled (phones/tablets) or that refused this computer show only the “It can” row. The master “Allow devices on this account to control this computer” switch on the This device card stays a switch. Implementation: [MyDevicesPanel.tsx](../../apps/desktop/src/renderer/components/settings/MyDevicesPanel.tsx). My devices is also where cloud computers are managed: for an organization member with a cloud computer entry, a 云主机 `SettingsCard` / `SettingsRow` sits pinned under this computer's card, with a one-line hint for the current state and `secondary` `sm` buttons 添加云主机 / 查看进度 / 管理云主机 that open the cloud computer web page; accounts without the entry show no row. A delivered cloud computer is an ordinary device in the list. The sidebar machine menu does not carry cloud computer entries. Implementation: [CloudComputerRow.tsx](../../apps/desktop/src/renderer/components/settings/CloudComputerRow.tsx).

### Teammate model settings

The model page shows the primary model with its backup chain, using the shared model picker and
retaining provider account, Harness, thinking level and Fast; the backup chain stays folded. The
separate task model group was removed with the setting: a teammate chooses a new task's
model when it starts the task. Reuse themed controls for Light/Dark; this contract does not claim
runtime visual verification.

### Teammate capability page

The teammate's Capabilities page follows the Memory page's grouped list: a quiet 12px/500 group
heading with a tabular count or summary (`1 of 3 on`, `Following this computer · 11`), then one
12px-radius card per group with 13px/500 names, one-line 12px descriptions (full text on hover)
and inset dividers. Groups in order: Core skill (always on, opens a read-only page with a
plain-language summary and the original text folded), Learned skills (switch; the page shows the content with Edit
and Delete), Skills on this computer, Built-in tools, MCP, Permissions (Input Handoff). A group
shows at most four rows, enabled first and unavailable last; the rest unfold under "Show N more"
with the shared grid `0fr ↔ 1fr` motion. Configuration lives in one heading link per group
(Manage / Tool settings) instead of a button on every row; an unavailable tool says so in its
note line with a "Turn on" link. Rows that open a page carry a trailing chevron and keep the switch
as a separate control. Light and Dark use the existing tokens; prototype and screenshots live in
the design archive for Cindy-伙伴能力页重设计-2026-11-01. Product rules: cindy-bots-runtime.md §6
「伙伴技能分层」. (2026-11-08: the System skills group — todo, routine, follow — was removed with
V2 teammates; the page no longer shows it.)

### About: harness versions

Each harness occupies one compact row. Pi shows the executable's actual version and a short
check/update status in that row. Its pill trigger opens a menu containing upstream update,
restore Cindy release, check again, and release notes; source versions never become permanently
expanded rows. Upstream compatibility risk appears only in the install confirmation. Installation
progress remains inside the row. Menus use the existing container and inner-row geometry, and
all states use semantic colors in both Light and Dark.

Claude Code and Codex use the same row, trigger and menu (`HarnessVersionMenuRow`), with only
the Cindy-maintained version chain: update to the current channel's version (shown right-aligned,
disabled unless strictly newer), check again, and the last successful check time. A later failed
online check keeps that last version in the menu but disables Update. There is no upstream
source, restore or release-notes entry. Updating first prepares the selected version in the
shared background cache, showing download status in the row, then follows the existing
confirm → busy warning → restart flow. Startup installs only a complete cache matching the
current manifest; if that target has changed or the cache is unavailable, it keeps a usable
old runtime and retries in the background. First-install and repair downloads retain their
existing startup fallback.
