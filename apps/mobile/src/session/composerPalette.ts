import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' | 'pi' | 'kimi-code' {
  return session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code';
}
