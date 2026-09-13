import type { RemoteSession } from './types';

export * from '@cindy/maker-shared/composer-palette';

export function agentKindForSession(session: Pick<RemoteSession, 'agentKind'>): 'claude-code' | 'codex' | 'pi' | 'grok-build' {
  return session.agentKind === 'codex' || session.agentKind === 'pi' || session.agentKind === 'grok-build'
    ? session.agentKind
    : 'claude-code';
}
