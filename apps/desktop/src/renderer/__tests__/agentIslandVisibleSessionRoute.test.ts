import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute,
  resolveAgentIslandVisibleSessionFromRouteTarget,
  resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail,
  resolveAgentIslandVisibleSessionIdFromPath,
} from '@/lib/agentIslandVisibleSessionRoute';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

const mainLayoutSource = readTextLf(
  resolve(__dirname, '..', 'components', 'layout', 'MainLayout.tsx'),
  'utf8',
);
const orcaSplitViewSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaSplitView.tsx'),
  'utf8',
);
const orcaWorkerPanelSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaWorkerPanel.tsx'),
  'utf8',
);
const workdirBrowseRouteSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseRoute.tsx'),
  'utf8',
);
const ccAgentSessionViewSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

describe('resolveAgentIslandVisibleSessionIdFromPath', () => {
  it('returns the session id only for routes that visibly show a session', () => {
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/session-a')).toBe('session-a');
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/orca/session-b')).toBeNull();
  });

  it('returns null for non-session routes', () => {
    expect(resolveAgentIslandVisibleSessionIdFromPath('/')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/settings')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/boot')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/new')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/new-dialogue')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/scheduled')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/files/session-a')).toBeNull();
    expect(resolveAgentIslandVisibleSessionIdFromPath('/cc-agent/orca/new')).toBeNull();
  });

  it('preserves Orca worker targets when acknowledging a complete route target', () => {
    expect(
      resolveAgentIslandVisibleSessionFromRouteTarget(
        '/cc-agent/lead-a?worker=worker-b&source=notification',
      ),
    ).toEqual(['lead-a', 'worker-b']);
    expect(resolveAgentIslandVisibleSessionFromRouteTarget('/cc-agent/lead-a')).toBe('lead-a');
    expect(resolveAgentIslandVisibleSessionFromRouteTarget('/cc-agent/lead-a?worker=new')).toBe(
      'lead-a',
    );
    expect(resolveAgentIslandVisibleSessionFromRouteTarget('/settings?worker=worker-b')).toBeNull();
  });

  it('lets the workdir browse route own visible-session reports for doc-mode rails', () => {
    expect(isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute('/cc-agent/files/session-a')).toBe(true);
    expect(isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute('/cc-agent/files')).toBe(false);
    expect(isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute('/cc-agent/session-a')).toBe(false);
  });

  it('reports doc-mode rail sessions only while the regular rail is visible', () => {
    expect(
      resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail({
        sessionId: 'session-a',
        railCollapsed: false,
        isOrcaLead: false,
      }),
    ).toBe('session-a');
    expect(
      resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail({
        sessionId: 'session-a',
        railCollapsed: true,
        isOrcaLead: false,
      }),
    ).toBeNull();
    expect(
      resolveAgentIslandVisibleSessionIdForWorkdirBrowseRail({
        sessionId: 'session-a',
        railCollapsed: false,
        isOrcaLead: true,
      }),
    ).toBeNull();
  });

  it('gates renderer visible-session IPC on the full Agent Island support check', () => {
    expect(mainLayoutSource).toContain("import { isAgentIslandSupported, toggleAgentIslandSoundEnabled } from '@/hooks/useAgentIslandSettings';");
    expect(mainLayoutSource).toContain('if (!isAgentIslandSupported()) return;');
    expect(mainLayoutSource).toContain('if (isAgentIslandVisibleSessionOwnedByWorkdirBrowseRoute(location.pathname)) return;');
    expect(orcaSplitViewSource).toContain("import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';");
    expect(orcaSplitViewSource).toContain('if (!isAgentIslandSupported()) return;');
    expect(orcaWorkerPanelSource).toContain("import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';");
    expect(orcaWorkerPanelSource).toContain('if (!isAgentIslandSupported()) return;');
    expect(workdirBrowseRouteSource).toContain("import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';");
    expect(workdirBrowseRouteSource).toContain('if (!isAgentIslandSupported()) return;');
    expect(workdirBrowseRouteSource).toContain('window.electronAPI.agentIsland?.setVisibleSession?.(agentIslandVisibleSessionId)');
    expect(orcaWorkerPanelSource).toContain('window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds)');
    expect(orcaWorkerPanelSource).toContain('viewVisible && workerSessionId && workerSessionId !== leadSessionId');
  });

  it('acknowledges notification focus navigation to collapse Agent Island after jumping', () => {
    expect(mainLayoutSource).toContain(
      'const visibleSession = resolveAgentIslandVisibleSessionFromRouteTarget(target);',
    );
    expect(mainLayoutSource).toContain(`if (isAgentIslandSupported()) {
          void window.electronAPI.agentIsland?.setVisibleSession?.(visibleSession);
        }`);
  });

  it('routes plugin setup navigation through the owning session view', () => {
    expect(mainLayoutSource).not.toContain('ghosts.onSetupNavigate');
    expect(ccAgentSessionViewSource).toContain(
      'if (!viewVisible || !sessionId || payload.sessionId !== sessionId) return;',
    );
    expect(ccAgentSessionViewSource).toContain(
      "navigate(`/plugins?ghost=${encodeURIComponent(payload.ghostId)}`);",
    );
    expect(ccAgentSessionViewSource).toContain("navigate('/settings?tab=providers');");
  });
});
