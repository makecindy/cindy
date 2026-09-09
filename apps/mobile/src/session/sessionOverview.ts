import { i18n } from '@/i18n';
import {
  summarizeSessionOverview as summarizeSessionOverviewShared,
  type SessionActionStripInput,
  type SessionOverviewModel,
} from '@cindy/maker-shared/session-action-strip';
import { sessionWorktreeLabel } from '@cindy/maker-shared/session-identity';
import { sessionCollaborationLabel } from '@/session/collaboration';

export {
  type SessionActionStripAction,
  type SessionActionStripActionId,
  type SessionActionStripInput,
  type SessionOverviewChip,
  type SessionOverviewModel,
} from '@cindy/maker-shared/session-action-strip';

export function buildSessionActionStrip(input: SessionActionStripInput): SessionOverviewModel {
  return summarizeSessionOverview(input);
}

export function summarizeSessionOverview(input: SessionActionStripInput): SessionOverviewModel {
  const base = summarizeSessionOverviewShared(input);
  const actionCopy = input.remoteUnavailableReason
    || (input.pendingCount > 0
      ? i18n.t('session.presentation.overview.actionCopy.pending')
      : input.readOnlyReason
        || (input.session.status === 'archived'
          ? i18n.t('session.presentation.overview.actionCopy.archived')
          : input.session.status === 'deleted'
            ? i18n.t('session.presentation.overview.actionCopy.deleted')
            : input.queuePaused
              ? i18n.t('session.presentation.overview.actionCopy.queuePaused')
              : null));
  return {
    ...base,
    actionCopy,
    actions: base.actions.map((action) => ({
      ...action,
      accessibilityLabel: action.id === 'search'
        ? i18n.t(`session.presentation.overview.actions.search.${input.searchOpen ? 'closeA11y' : 'openA11y'}`)
        : i18n.t(`session.presentation.overview.actions.${action.id}.a11y`),
      disabledReason: localizeActionDisabledReason(action.id, input),
      label: action.id === 'queue' && input.queuePaused
        ? i18n.t('session.presentation.overview.queuePaused')
        : i18n.t(`session.presentation.overview.actions.${action.id}.label`),
    })),
    attentionLabel: input.pendingCount > 0
      ? i18n.t('session.presentation.overview.pendingCount', { count: input.pendingCount })
      : input.readOnlyReason
        ? i18n.t('session.presentation.overview.readOnly')
        : input.session.status === 'archived'
          ? i18n.t('session.presentation.overview.status.archived')
          : input.queuePaused
            ? i18n.t('session.presentation.overview.queuePaused')
          : null,
    runtimeSubtitle: [
      sessionCollaborationLabel(input.session),
      sessionWorktreeLabel(input.session),
      input.session.agentKind === 'codex'
        ? 'Codex'
        : input.session.agentKind === 'pi'
          ? 'Pi'
          : 'Claude Code',
      input.session.model,
      input.session.permissionMode,
      input.session.fastMode ? 'Fast' : null,
    ].filter(Boolean).join(' · '),
    stateChips: base.stateChips.map((chip) => ({
      ...chip,
      label: chip.id === 'pending'
        ? i18n.t('session.presentation.overview.pendingCount', { count: input.pendingCount })
        : chip.id === 'remote-unavailable'
          ? i18n.t('session.presentation.overview.unavailable')
          : chip.id === 'read-only'
            ? i18n.t('session.presentation.overview.readOnly')
            : chip.id === 'queue-paused'
              ? i18n.t('session.presentation.overview.queuePaused')
              : chip.id === 'status'
                ? i18n.t(`session.presentation.overview.status.${input.session.status}`, {
                    defaultValue: i18n.t('session.presentation.overview.status.active'),
                  })
                : chip.label,
    })),
  };
}

function localizeActionDisabledReason(
  id: SessionOverviewModel['actions'][number]['id'],
  input: SessionActionStripInput,
): string | null {
  if (id === 'files') {
    return input.session.workingDir
      ? null
      : i18n.t('session.presentation.overview.disabled.files');
  }
  if (id === 'search') {
    return input.messageCount > 0
      ? null
      : i18n.t('session.presentation.overview.disabled.search');
  }
  if (id !== 'queue') return null;
  const queueAvailable = input.queueAvailable ?? input.queueCount > 0;
  if (queueAvailable) return null;
  if (input.remoteUnavailableReason) return i18n.t('session.presentation.overview.disabled.queueUnavailable');
  if (input.pendingCount > 0) return i18n.t('session.presentation.overview.disabled.queuePending');
  if (input.queuePaused) return i18n.t('session.presentation.overview.disabled.queuePausedEmpty');
  if (input.queueCount <= 0) return i18n.t('session.presentation.overview.disabled.queueEmpty');
  return i18n.t('session.presentation.overview.disabled.queueDefault');
}
