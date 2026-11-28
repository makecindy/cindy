# 任务侧栏

> 迁自 `DESIGN.md` §2、§5，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动桌面任务侧栏、伙伴侧栏或任务创建者筛选之前
> **适用路径**：`apps/desktop/src/renderer/features/cc-agent/sidebar/**`、`apps/desktop/src/renderer/features/bots/TeammatesSection.tsx`、`apps/mobile/src/session/HomeDisplayMenu*.tsx`、`apps/mobile/src/session/homeChromeMenus.ts`、`apps/mobile/src/session/homeDisplaySettings.ts`、`apps/mobile/src/session/homeViewPreferenceStore.ts`、`apps/mobile/src/platform/chrome/useNativeMenuReminderImage.ts`

### Filter reminder inside display settings

Mobile only since 2026-11-28: the Desktop display-settings menu no longer
marks archived tasks, on its button or inside the menu.

When the sidebar display-settings trigger shows the archived-view reminder, repeat
the same static accent dot on the Task status submenu and its selected Archived
option. Desktop and Mobile retain neutral labels and selection checkmarks. Active
and All remove the whole reminder path. Native iOS menus retain their system UIMenu
and toolbar presenters and use the image slot for the dot. MenuView receives an
absolute path to a temporary 1x copy of the bundled PNG: a 20pt canvas containing
the same 6pt dot. Ordinary row icons and selection checkmarks remain available.
Custom menus remain fallback paths and use the shared inline dot. This extends
the existing filter reminder registration without changing which settings light
the entry indicator.

### Desktop task sidebar identity

Individually pinned tasks stay out of the ordinary list. Automatic task groups use two presentation modes:
while expanded, history includes the task represented by the group header, whether read or unread;
while collapsed, omit that task from the visible attention rows so it only appears in the header.
Deduplicate collapsed rows by task ID, not title. The header keeps its existing click target (latest run,
or the failing run when a collapsed group reports an error). Expanded preview limits, frozen layouts
and “Show all” continue to include the header task.
Non-silent unread runs and pending errors/replies remain visible while collapsed, without a five-row cap;
a task already represented by the header satisfies this visibility rule. Silent successful runs and
read history stay hidden unless the group is expanded.
Implementation: `AutomationSessionGroupItem.tsx` and `automationSidebarGrouping.ts`; regression:
`automationGroupCollapsedAlerts.test.tsx` and the `automation-unread` UI fixture.

### Desktop teammate sidebar

The teammate display-style menu adds a separated “Show avatars when collapsed” checkbox. It defaults off on Desktop, preserving the existing attention-only collapse behavior, and stores explicit choices per account on this computer. Enabling it shows all visible chats as a single avatar strip while collapsed, regardless of the expanded icon/list preference; overflow uses the existing +N entry, which expands the section into the full list. Disabling it restores the existing attention exception without changing the fold or expanded display style. Mobile keeps its own existing default-on choice. Implementation and regressions: `TeammatesSection.tsx`, `teammatesSectionPrefs.ts`, their existing unit tests and the `collapse-attention` UI fixture.

The expanded teammate section previews five chats (local teammates, remote teammates, groups and the merged Cindy device row share this limit). Keep the current chat visible within those five rows. Use the task list’s “Show all N” footer style, with “Show less” after expansion. The teammate section has its own icon/list preference, independent of the pinned section and of collapse state. The icon strip’s +N button switches to the full list. With collapsed avatars disabled, collapsing resets the preview and hides ordinary entries entirely; unread chats and pending interaction/error rows remain visible in the chosen mode, without a preview cap. The currently open teammate chat also stays visible after it becomes read, until navigation leaves that chat; pending attention still keeps it visible after leaving. Explicitly collapsing the teammate section hides a read selection immediately; new unread or pending attention restores its visibility and read-until-leaving protection. This applies to both icon and list modes. The pinned section follows the same attention exception, including tasks inside pinned projects. This limit applies to the Desktop sidebar; the Mobile task home section below previews three.

### Desktop and Mobile task creator filters

The sidebar's existing Filter submenu adds Teammates. All (全部) is the default and includes personal tasks and all teammates' tasks;
choosing one teammate selects only its created tasks, then further choices add or remove teammates.
Hide all (都不显示) excludes teammate-created tasks and teammate routine/IM tasks while retaining personal tasks.
On Desktop this choice moved out of the Teammates submenu on 2026-11-28: it is the 「伙伴的任务」 checkbox
under the display-settings menu's 「隐藏」 row, with the same stored value and matching rule; Mobile keeps it in Filter.
Since V2 a task belongs to a teammate here when it runs in that teammate's project or the
teammate opened it with `send_to_session` (children of its old V1 background tasks still count, read from
the stored rows); V1 workbench takeovers no longer count, and teammate projects are left out of the sidebar and search project filters.
Selecting a teammate from Hide all switches to that teammate; removing the last choice restores All. Reset Filters also clears this dimension, preserving task status,
grouping and sorting. Pinned entries retain their existing exemption from content filters.
Use the existing menu rows, avatar component and check marks; keep the menu open for multiple choices.
Show a remote computer name only for device-scoped identities, to distinguish same-name teammates.
Cindy and cloud companions use a single name row without a computer subtitle: their filters span computers. Persist selections
per viewer account. Built-in Cindy is one choice across computers; choosing it includes every copy’s
created tasks, including archived history. Identify it from preset/cloud identity, never its name; custom
namesakes remain separate. Existing per-computer Cindy selections migrate to the unified choice.
Cloud companions use their account identity across old and current computers; retired copies stay out
of the choices, as in the teammate roster. Unlinked teammates remain keyed by computer and teammate ID.
Creation attribution is distinct from following. Existing teammate routine and IM channel tasks also
appear in the desktop task list and share this filter. Their exact linked owner supplies the avatar;
the tooltip says “Belongs to” to distinguish ownership from delegation or following. Active/archived
filters still apply; main chats, private threads and internal group lanes retain their dedicated entries.
Task rows retain their creator avatar after archiving, on both local and remote computers. Prefer the
creator's avatar when others follow the same task; the tooltip distinguishes creation from following.
Two-line teammate rows grow with their content; align the avatar and check mark with the name line,
keeping the computer name in the same text column and preserving vertical padding.
Verify the menu in every supported UI locale and both themes; long names retain the existing menu width.
Mobile uses the same multi-selection semantics in the existing iOS native / Android display menus.
The home (including the task drawer) and device task lists retain creation/ownership avatars after
archiving and cold start. Read the existing teammate delegation and history APIs on older hosts;
keep main chats and internal lanes out of these lists. Cache only portable ownership/avatar metadata
in the account-scoped home snapshot. Late cloud/preset discovery canonicalizes existing selections
without clearing the list or splitting Cindy by computer.
