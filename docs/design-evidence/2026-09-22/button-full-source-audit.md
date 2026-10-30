# Desktop functional Button: full-source audit

Date: 2026-09-22. Scope: follow-up to button-state-audit.md; no commit or PR.

## Cause and implementation

The earlier migration followed the Lab migration bucket and missed review-bucket native actions, private wrappers, dynamic labels, and CSS-only definitions. This pass scanned renderer native JSX, explicit button roles, input action types, wrapper definitions and their calls, plus ordinary action-menu triggers. It added 119 shared Button definitions/text branches across 66 consumer files. The shared API also retains opaque archive-confirmation paint (danger-surface) and permit-action palette colors.

Production calls now contain 509 shared Button JSX references across 170 files. The remaining 748 native button definitions include the Button primitive itself, icon controls, selections, navigation, menu rows, content triggers, login and input-specific surfaces. They are not a claim of 748 missed functional buttons. No ordinary migrated consumer retains its own background/hover/scale rules; layout classes remain local.

## Scope decisions

- Functional actions use Button directly or through thin wrappers (Storage CardButton, plugin pills, simulator ActionButton, and text branches of Review ActionButton).
- Pure icons stay separate, including responsive Review branches. Select triggers, avatars, cards, menu rows, expanders, keycaps, and platform controls retain their owning rules.
- Underlined/text-link actions remain for later user confirmation. AI composer/send controls remain excluded. Login and independent main-process authorization HTML retain specialized design contracts.
- Original handlers, disabled expressions, refs, keyboard and aria attributes are preserved; mixed branches retain the same handlers. Legacy ConfirmDialog retains non-shrinking single-line labels and wraps the action group.

## Verification

- Desktop typecheck passed.
- Seven live client pages in Light and Dark: 106 observed Button instances; enabled hover/pressed paint and 1px face inset present, hitbox/content stable. Screenshots inspected for storage Light/Dark.
- Final root related unit run: 4319 passed, 1 skipped, 1 failed (existing windowBackdropAcrylic.test.ts main-source formatting assertion; neither main source nor that test changed in this task). No commit was made. The later aria-disabled style correction passed 46 focused Button/state-contrast tests and Desktop typecheck.
- Focused keyboard, worker creation and archive visual tests cover the final additions; archive retained opaque paint after a test caught a real background regression.
- Business-attribute AST comparison and full shared-class scan are in the local verification artifacts. No deletion, purchase, publish or similar business action was triggered during UI checking.
- Design Lab captures current implementation on the right and retains the historical left, all 1446 existing feedback IDs, and a separate icon scope. Source positions are not runtime counts or user acceptance.

## Final rendered review

- Design Lab functional scope: 633 positions (533 shared, 80 review, 20 special including 2 independent-window entries); pure icon scope: 169. Review labels do not imply user acceptance.
- All 633 before/after positions rendered in Light and Dark (1266 render records); all 28 contact sheets visually inspected. Corrected the About legal-document example through fixture data in a new preview; no historical snapshot overwritten.
- All 533 shared after specimens checked in Light/Dark for hover and active via browser CSS pseudo states (2132 checks): zero findings after fixing aria-disabled. Disabled tooltip-preserving Review actions no longer change paint; native focus/interaction semantics remain unchanged. These are specimen state checks, not all live business paths.
- Live client verification remains the seven pages / 106 observed buttons above. No destructive business action invoked.
- Final website deploy:prepare passed (site, review, workbench, spec, shared UI, Button scope, icon scope and feedback checks). Publication is pending the XD Sites current-summary confirmation; no upload occurred at this checkpoint.
- Final snapshots: 2026-09-22-final coverage; 2026-09-22-finalpreview2 render. Every original feedback identity retained.

## Changed action definitions

| Source | Original line | Shared props |
| --- | ---: | --- |
| components/settings/TelegramRemoteDevices.tsx | 234 | variant="secondary" size="sm" compact loading={busyDeviceId === d.deviceId} |
| components/settings/RemoteDesktopPermissions.tsx | 102 | variant="secondary" size="sm" compact tone="quiet" |
| components/settings/HelpAssistantPanel.tsx | 26 | variant="secondary" size="sm" compact |
| components/settings/PiPackagesSection.tsx | 343 | variant="secondary" size="md" compact loading={busy?.action === "install"} |
| components/settings/PiPackagesSection.tsx | 393 | variant="secondary" size="md" compact |
| features/cc-agent/HomeZeroModelAction.tsx | 37 | variant="cta" size="lg" compact |
| features/skillhub/ScanResultDialog.tsx | 341 | variant="secondary" size="lg" compact |
| features/skillhub/ScanResultDialog.tsx | 364 | variant="cta" size="lg" compact |
| features/scheduler/components/ScheduleFormDialog.tsx | 1112 | variant={hookGenOpen ? "primary" : "secondary"} size="lg" compact |
| features/scheduler/components/BoundSessionCard.tsx | 57 | variant="secondary" size="sm" compact tone="quiet" |
| features/scheduler/components/BoundSessionCard.tsx | 72 | variant="secondary" size="sm" compact tone="quiet" |
| components/new-chat/FolderPickerPopover.tsx | 363 | variant="secondary" size="xs" compact tone="danger" |
| features/scheduler/components/ScheduleChips.tsx | 1316 | variant="secondary" size="md" compact tone="quiet" |
| features/plugin/UpdateAllDialog.tsx | 133 | variant={finished ? "cta" : "secondary"} size="lg" compact |
| features/plugin/MarketPluginDetailView.tsx | 89 | variant="cta" size="lg" compact loading={busy} |
| features/cc-agent/sidebar/ConversationSearchBox.tsx | 990 | variant="secondary" size="xxs" compact tone="quiet" |
| features/skillhub/components/InstallTargetPicker.tsx | 262 | variant="secondary" size="md" compact |
| features/right-sidebar/plugins/web-browser/BrowserTabBody.tsx | 531 | variant="secondary" size="xxs" compact tone="danger" |
| features/right-sidebar/plugins/ios-simulator/IOSSimulatorTabBody.tsx | 2922 | variant="secondary" size="md" compact loading={spinning} allowWhileLoading |
| components/chat/TextLightbox.tsx | 595 | variant="cta" size="lg" compact |
| components/settings/SessionShareImportWizard.tsx | 377 | variant="secondary" size="md" compact palette="confirmation" |
| components/settings/SessionShareImportWizard.tsx | 450 | variant="secondary" size="md" compact palette="confirmation" |
| components/settings/SessionShareImportWizard.tsx | 465 | variant="cta" size="md" compact palette="confirmation" loading={unlocking} |
| components/settings/SessionShareImportWizard.tsx | 483 | variant="secondary" size="md" compact palette="confirmation" |
| components/settings/SessionShareImportWizard.tsx | 494 | variant="cta" size="md" compact palette="confirmation" |
| components/settings/SessionShareImportWizard.tsx | 509 | variant="cta" size="md" compact palette="confirmation" loading={step === "committing"} |
| components/settings/SessionShareImportWizard.tsx | 527 | variant="secondary" size="md" compact palette="confirmation" |
| components/settings/SessionShareImportWizard.tsx | 538 | variant="cta" size="md" compact palette="confirmation" |
| components/settings/TelegramBehaviorSettings.tsx | 97 | variant="secondary" size="sm" compact |
| components/settings/WorkLouderCodexKeyboardLayout.tsx | 618 | variant="cta" size="md" compact |
| components/settings/KeyboardShortcutsSection.tsx | 511 | variant="secondary" size="sm" compact tone="quiet" |
| components/settings/ExperimentalSection.tsx | 90 | variant="cta" size="md" compact |
| components/settings/UnifiedModelList.tsx | 1352 | variant="secondary" size="xxs" compact tone="quiet" |
| components/markdown/MermaidSourceEditor.tsx | 225 | variant="secondary" size="md" compact tone="quiet" |
| components/markdown/MermaidSourceEditor.tsx | 236 | variant="cta" size="md" compact |
| components/chat/TurnChangesCard.tsx | 213 | variant="secondary" size="md" compact tone="quiet" loading={applying} |
| components/chat/TurnChangesCard.tsx | 250 | variant="secondary" size="md" compact |
| components/chat/TurnChangesCard.tsx | 286 | variant="secondary" size="md" compact tone="quiet" |
| components/chat/GhostToolCard.tsx | 790 | variant="secondary" size="xs" compact |
| components/chat/SystemCard.tsx | 1370 | variant="secondary" size="xs" compact tone="quiet" |
| components/chat/ToolPayloadLightbox.tsx | 539 | variant="secondary" size="md" compact |
| components/chat/ToolPayloadLightbox.tsx | 551 | variant="cta" size="md" compact |
| components/settings/XboxGamepadSettings.tsx | 562 | variant="cta" size="md" compact |
| components/settings/FontFamilyPicker.tsx | 245 | variant="secondary" size="lg" compact |
| components/sidebar/AccountSwitcherDialog.tsx | 250 | variant="secondary" size="lg" compact loading={addingAccount} |
| components/ui/toast/Toast.tsx | 146 | variant="secondary" size="sm" compact |
| components/settings/HookConnectionsSection.tsx | 1247 | variant="secondary" size="xs" compact |
| components/UpdateNoticeDialog.tsx | 358 | variant="secondary" size="xxs" compact |
| components/settings/contacts/ContactsListPane.tsx | 120 | variant="cta" size="md" compact |
| components/settings/contacts/ContactDetailPane.tsx | 791 | variant="cta" size="md" compact loading={saving} |
| components/settings/contacts/ContactsImportDialog.tsx | 288 | variant="cta" size="md" compact loading={loading} |
| components/settings/contacts/ContactsImportDialog.tsx | 344 | variant="secondary" size="md" compact |
| components/settings/contacts/ContactsManagerDialog.tsx | 304 | variant="secondary" size="md" compact |
| features/bots/RemoteBotSessionView.tsx | 112 | variant="secondary" size="md" compact |
| features/bots/BotSessionView.tsx | 221 | variant="cta" size="lg" compact |
| features/bots/BotDeleteDialog.tsx | 87 | variant="cta" size="lg" compact tone="danger-solid" loading={busy} |
| features/learn/LearnReviewPanel.tsx | 185 | variant="secondary" size="md" compact tone="quiet" loading={acting === "discard"} |
| features/learn/LearnReviewPanel.tsx | 193 | variant="cta" size="md" compact loading={acting === "apply"} |
| features/cc-agent/RenameSessionsConfirmCard.tsx | 104 | variant="secondary" size="md" compact |
| features/cc-agent/RenameSessionsConfirmCard.tsx | 117 | variant="cta" size="md" compact |
| features/cc-agent/IssueConfirmCard.tsx | 387 | variant="secondary" size="md" compact |
| features/cc-agent/IssueConfirmCard.tsx | 402 | variant="cta" size="md" compact |
| features/cc-agent/HomeSuggestionList.tsx | 136 | variant="secondary" size="xs" compact tone="quiet" |
| features/cc-agent/HomeSuggestionList.tsx | 149 | variant="secondary" size="xs" compact tone="quiet" |
| features/learn/LearnStatusCard.tsx | 121 | variant="secondary" size="xs" compact tone="quiet" |
| features/learn/LearnStatusCard.tsx | 130 | variant="secondary" size="xs" compact tone="quiet" |
| features/learn/LearnStatusCard.tsx | 140 | variant="cta" size="xs" compact |
| features/cc-agent/sidebar/SessionShareExportDialog.tsx | 245 | variant="secondary" size="md" compact palette="confirmation" |
| features/cc-agent/sidebar/SessionShareExportDialog.tsx | 257 | variant="cta" size="md" compact palette="confirmation" loading={exporting} |
| features/cc-agent/workdir-browse/OpenInSystemActions.tsx | 52 | variant="cta" size="md" compact |
| features/cc-agent/workdir-browse/OpenInSystemActions.tsx | 63 | variant="secondary" size="md" compact |
| features/right-sidebar/plugins/web-browser/BrowserTabBody.tsx | 634 | variant="cta" size="sm" compact |
| features/right-sidebar/plugins/web-browser/BrowserTabBody.tsx | 643 | variant="secondary" size="sm" compact tone="danger" |
| features/right-sidebar/plugins/file-browser/FileBrowserBody.tsx | 828 | variant="secondary" size="xs" compact tone="quiet" |
| features/right-sidebar/plugins/web-browser/BrowserCommentPopover.tsx | 372 | variant="secondary" size="xxs" compact tone="quiet" |
| features/right-sidebar/plugins/web-browser/BrowserCommentPopover.tsx | 409 | variant="secondary" size="xs" compact tone="quiet" |
| features/right-sidebar/plugins/web-browser/BrowserCommentPopover.tsx | 421 | variant="cta" size="xs" compact loading={submitting} |
| features/right-sidebar/plugins/terminal/TerminalTabBody.tsx | 288 | variant="secondary" size="xs" compact loading={restarting} |
| features/right-sidebar/plugins/terminal/TerminalTabBody.tsx | 320 | variant="secondary" size="xs" compact loading={restarting} |
| features/right-sidebar/plugins/review/ReviewTabBody.tsx | 4265 | variant="secondary" size="md" compact |
| features/right-sidebar/plugins/review/DiffViewer/PlainUnifiedDiff.tsx | 409 | variant="secondary" size="xs" compact |
| components/ui/confirm-dialog.tsx | 366 | variant="cta" palette="confirmation" size="lg" tone={confirmVariant === "destructive" ? "danger-solid" : "default"} loading={loading} |
| components/ui/confirm-dialog.tsx | 406 | variant="secondary" palette="confirmation" size="lg" |
| components/ui/confirm-dialog.tsx | 426 | variant="secondary" palette="confirmation" size="lg" |
| components/new-chat/PluginSetupPrompt.tsx | 328 | variant="cta" palette="confirmation" size="lg" compact loading={busy} |
| components/new-chat/PluginSetupPrompt.tsx | 398 | variant="secondary" size="lg" compact |
| components/new-chat/PluginSetupPrompt.tsx | 404 | variant="cta" palette="confirmation" size="lg" compact loading={busy} |
| components/new-chat/PluginSetupPrompt.tsx | 428 | variant="secondary" palette="confirmation" size="lg" compact |
| components/new-chat/PluginSetupPrompt.tsx | 591 | variant="cta" palette="confirmation" size="lg" compact loading={busy} |
| components/new-chat/AskUserQuestionPrompt.tsx | 481 | variant="secondary" palette="confirmation" size="lg" compact |
| components/new-chat/AskUserQuestionPrompt.tsx | 496 | variant="secondary" palette="confirmation" size="lg" compact |
| components/new-chat/AskUserQuestionPrompt.tsx | 509 | variant="secondary" palette="confirmation" size="lg" compact |
| features/right-sidebar/plugins/resource-usage/ResourceUsageBody.tsx | 396 | variant="secondary" size="md" compact |
| components/settings/contacts/ContactsListPane.tsx | 186 | variant="cta" size="md" compact |
| components/settings/contacts/ContactDetailPane.tsx | 344 | variant="secondary" tone="danger" size="sm" compact |
| components/settings/contacts/ContactDetailPane.tsx | 776 | variant="secondary" tone="quiet" size="md" compact |
| components/settings/contacts/ContactsManagerDialog.tsx | 281 | variant="secondary" size="md" compact loading={syncPending} |
| components/settings/contacts/ContactsSection.tsx | 242 | variant="secondary" size="md" compact |
| components/settings/contacts/ContactsSection.tsx | 308 | variant="secondary" size="md" compact loading={syncPending} |
| components/chat/GhostToolCard.tsx | 781 | variant="secondary" tone="quiet" size="xs" compact |
| features/right-sidebar/plugins/review/ReviewTabBody.tsx | 1922 | shared text action; native icon-only retained |
| features/right-sidebar/plugins/review/ReviewTabBody.tsx | 4298 | shared text action; native icon-only retained |
| components/settings/VoiceInputSection.tsx | 899 | permission grant uses shared; granted badge retained |
| components/settings/WorkLouderCodexKeyboardLayout.tsx | 558 | variant="secondary" size="md" compact |
| components/settings/WorkLouderCodexKeyboardLayout.tsx | 568 | variant="cta" size="md" compact |
| components/ui/cross-agent-convert-dialog.tsx | 114 | variant="secondary" palette="confirmation" size="lg" |
| components/ui/cross-agent-convert-dialog.tsx | 131 | variant="cta" palette="confirmation" size="lg" loading={isRunning} |
| features/bots/BotModelChainEditor.tsx | 200 | variant="secondary" tone="quiet" size="md" compact |
| features/cc-agent/CreateWorkerPopover.tsx | 862 | variant="cta" palette="confirmation" size="lg" loading={isSubmitting} |
| features/cc-agent/GhostGrantConfirmCard.tsx | 156 | variant="secondary" size="md" compact |
| features/cc-agent/GhostGrantConfirmCard.tsx | 169 | variant="primary" size="md" compact |
| features/cc-agent/sidebar/SessionCard.tsx | 911 | variant="secondary" tone="danger" size="xxs" compact |
| features/cc-agent/sidebar/SessionCard.tsx | 1272 | variant="secondary" tone="danger" size="xxs" compact |
| features/cc-agent/sidebar/SessionItem.tsx | 1134 | variant="secondary" tone="danger" size="xs" compact |
| components/settings/contacts/ContactsListPane.tsx | 242 | variant="secondary" tone="quiet" size="md" compact |
| features/maker-experimental/MakerExperimentalView.tsx | 171 | variant="secondary" size="md" compact |
| features/maker-experimental/MakerExperimentalView.tsx | 253 | variant="cta" size="md" compact |
| features/maker-experimental/MakerExperimentalView.tsx | 259 | variant="secondary" tone="danger-solid" size="md" compact |
| features/maker-experimental/MakerExperimentalView.tsx | 311 | variant="primary" size="md" compact |
