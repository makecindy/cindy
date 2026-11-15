import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import type { AgentIslandSessionSnapshot } from '../../shared/agentIsland.js';
import type { MenubarActivity } from '../../shared/menubarQuota.js';
import { MENUBAR_HARNESS_LOGOS } from './logos.js';
import type { MenubarTranslate } from './snapshot.js';

/** Preserve the island's candidate order and attention; output updates must not reorder tasks. */
export function buildMenubarActivities(
  sessions: readonly AgentIslandSessionSnapshot[],
  privacy: boolean,
  t: MenubarTranslate,
): MenubarActivity[] {
  return sessions.map((session): MenubarActivity => {
    const companion = session.companion;
    const harness =
      session.agentKind === 'codex' ? 'codex' : session.agentKind === 'pi' ? 'pi' : 'claude-code';
    const status = t(
      `ui.activity${
        {
          running: 'Running',
          'needs-interaction': 'Waiting',
          completed: 'Completed',
          error: 'Error',
        }[session.phase]
      }`,
    );
    return {
      sessionId: session.sessionId,
      title: privacy
        ? t(companion ? 'ui.privateCompanion' : 'tasks.private', {
            harness: t(`harness.${harness}`),
          })
        : companion
          ? [companion.groupName, companion.name].filter(Boolean).join(' · ')
          : isDefaultDraftSessionTitle(session.title) || !session.title.trim()
            ? t('ui.untitledTask')
            : session.title,
      logoSvg: MENUBAR_HARNESS_LOGOS[harness],
      companion: !!companion,
      attention: session.attention,
      phase: session.phase,
      preview: privacy
        ? status
        : (session.messagePreview?.text || session.compactDetail || session.detail || status)
            .replace(/\s+/g, ' ')
            .slice(0, 240),
      status,
      startedAtMs: session.phase === 'running' ? session.startedAt : null,
      lastActivityAtMs: session.lastActivityAt,
    };
  });
}
