import './environment';
import { useCallback, useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import type { UiPageRuntime } from '../../ui-page/harness/types';
import { TerminalTabBody } from '../../../src/renderer/features/right-sidebar/plugins/terminal/TerminalTabBody';
import type { TerminalState } from '../../../src/renderer/features/right-sidebar/plugins/terminal';
import { getOrCreateXterm } from '../../../src/renderer/features/right-sidebar/plugins/terminal/lib/xtermPool';

/** Exercise the production SSH setup and xterm overlays without opening a real shell. */
function Fixture({ scenario }: { scenario: string }) {
  const [state, setState] = useState<TerminalState>(() => {
    if (scenario === 'expired-reference') {
      getOrCreateXterm('fixture-terminal').remoteDraft = {
        contextKey: JSON.stringify(['fixture-session', null, 'fixture-host']),
        connection: { host: 'build.example.com', user: 'builder', hostRef: 'expired' }, submitted: false,
      };
    }
    return { created: scenario === 'exited', title: '', shellId: '', shellDisplayName: '', exited: null };
  });
  const patchState = useCallback((patch: unknown) => setState(value => ({ ...value, ...(patch as Partial<TerminalState>) })), []);
  return <main className="h-full min-w-0" data-ui-page-subject>
    <TerminalTabBody state={state} active ctx={{
      tabId: 'fixture-terminal', sessionId: 'fixture-session', workdir: '/workspace',
      remoteHostId: 'fixture-host', deviceLinkDeviceId: null, patchState,
      onVisibilityChange: () => {}, setCloseInterceptor: () => () => {},
    }} />
  </main>;
}

void mountPage({
  host: ({ case: scenario }) => ({
    appearanceSettings: { getSync: () => ({}), onChanged: subscription('appearance') },
    terminal: {
      create: async () => {
        if (scenario === 'connecting') return new Promise(() => {});
        if (scenario === 'error') throw new Error('[TERMINAL_SPAWN_FAILED] ' + 'remote-host-unreachable.'.repeat(12));
        if (scenario === 'default' || scenario === 'invalid') throw new Error('[PRECONDITION_FAILED] prepare');
        // Main replays a stored exit to the new subscription during attach.
        if (scenario === 'exited') {
          (window as unknown as { __uiPage: UiPageRuntime }).__uiPage.emit!('terminalExit', {
            id: 'fixture-terminal', exit: { code: 255, signal: null },
          });
        }
        return { shellId: 'ssh', shellDisplayName: 'SSH', pid: 1 };
      },
      describeRemote: async () => ({
        context: { sessionId: 'fixture-session' },
        target: { key: 'fixture-host', label: 'Build server', cwd: '/workspace' },
        connection: null,
        candidates: [{ host: 'build.example.com', user: 'builder', ...(scenario === 'expired-reference' ? { hostRef: 'fresh' } : {}) }],
      }),
      resize: async () => {}, write: async () => {}, dispose: async () => {},
      restart: async () => ({ shellId: 'ssh', shellDisplayName: 'SSH', pid: 2 }),
      onData: subscription('terminalData'), onExit: subscription('terminalExit'),
    },
  }),
  render: ({ case: scenario }) => <Fixture scenario={scenario} />,
});
