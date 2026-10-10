import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' | 'pi' | 'cursor' {
  return session.agentKind === 'codex' || session.agentKind === 'pi' || session.agentKind === 'cursor' ? session.agentKind : 'claude-code';
}
