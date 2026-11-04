import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' | 'pi' | 'zcode' {
  return session.agentKind === 'codex' || session.agentKind === 'pi' || session.agentKind === 'zcode' ? session.agentKind : 'claude-code';
}
