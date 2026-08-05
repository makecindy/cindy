import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' {
  return session.agentKind === 'codex' ? 'codex' : 'claude-code';
}
