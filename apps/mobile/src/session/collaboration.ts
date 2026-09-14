import { i18n } from '@/i18n';
import {
  isCollaborationSession,
  type SessionCollaborationLike,
} from '@cindy/maker-shared/session-identity';

export { isCollaborationSession };

export function sessionCollaborationLabel(session: SessionCollaborationLike): string | null {
  if (session.orcaRole === 'lead') return i18n.t('session.presentation.collaboration.labelLead');
  if (session.orcaRole === 'worker') return i18n.t('session.presentation.collaboration.labelWorker');
  return typeof session.orcaRole === 'string' && session.orcaRole.trim()
    ? i18n.t('session.presentation.collaboration.labelRole', { role: session.orcaRole.trim() })
    : null;
}

export function sessionCollaborationNotice(session: SessionCollaborationLike | null): string | null {
  if (!session) return null;
  if (session.orcaRole === 'lead') return i18n.t('session.presentation.collaboration.noticeLead');
  if (session.orcaRole === 'worker') return i18n.t('session.presentation.collaboration.noticeWorker');
  return isCollaborationSession(session)
    ? i18n.t('session.presentation.collaboration.noticeOther')
    : null;
}

export function sessionCollaborationReadOnlyReason(
  session: SessionCollaborationLike | null,
): string | null {
  return isCollaborationSession(session)
    ? i18n.t('session.presentation.collaboration.readOnlyReason')
    : null;
}

export function sessionCollaborationComposerReadOnlyReason(
  session: SessionCollaborationLike | null,
): string | null {
  if (!isCollaborationSession(session) || session?.orcaRole === 'lead') return null;
  return i18n.t('session.presentation.collaboration.composerReadOnlyReason');
}
