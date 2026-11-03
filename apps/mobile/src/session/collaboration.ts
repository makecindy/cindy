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
