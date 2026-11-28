import { mountPage } from '../../ui-page/harness';
import { XcodeBuildOutput } from '../../../src/renderer/features/cc-agent/workdir-browse/XcodeBuildOutput';
import { XcodeBuildToolbar } from '../../../src/renderer/features/cc-agent/workdir-browse/XcodeBuildToolbar';
import type { UseXcodeBuildReturn } from '../../../src/renderer/features/cc-agent/workdir-browse/hooks/useXcodeBuild';
import type { XcodeBuildState } from '../../../src/shared/xcodeBuild';

// PR: Xcode/Flutter build toolbar. Unit tests prove the state machine in useXcodeBuild;
// they cannot prove the bar paints registered tokens, that every affordance carries a
// translated accessible name, or that it still fits the sidebar rail at 320 px.
// Minimum failures: a raw `ccAgent.…` key as a label, a disabled Build that should be
// enabled, hot-reload actions leaking onto a native build, or an overflowing bar.
// Tier: opt-in UI integration over a prop fixture; no Xcode, no process, no IPC.

const SIMULATOR = {
  id: 'sim:iPhone 17',
  platform: 'iOS Simulator',
  name: 'iPhone 17',
  osVersion: '18.0',
  kind: 'simulator' as const,
};

const DEVICE = {
  id: 'dev:Simon iPhone',
  platform: 'iOS',
  name: 'Simon iPhone',
  osVersion: '18.1',
  kind: 'device' as const,
};

function buildState(overrides: Partial<XcodeBuildState> = {}): XcodeBuildState {
  return {
    buildId: 'fixture-build',
    workdir: '/fixture/app',
    status: 'running',
    phase: 'building',
    supportsHotReload: false,
    exitCode: null,
    startedAt: 0,
    endedAt: null,
    ...overrides,
  };
}

function xcode(overrides: Partial<UseXcodeBuildReturn> = {}): UseXcodeBuildReturn {
  const noop = () => undefined;
  return {
    available: true,
    loading: false,
    error: null,
    projects: [{ containerPath: 'Runner.xcworkspace', containerKind: 'workspace', name: 'Runner' }],
    selectedContainerPath: 'Runner.xcworkspace',
    schemes: ['Runner'],
    selectedScheme: 'Runner',
    destinations: [SIMULATOR, DEVICE],
    selectedDestination: SIMULATOR,
    build: null,
    output: '',
    outputExpanded: false,
    selectProject: async () => undefined,
    selectScheme: async () => undefined,
    selectDestination: noop,
    startBuild: async () => true,
    stopBuild: async () => undefined,
    hotReload: async () => undefined,
    hotRestart: async () => undefined,
    toggleOutput: noop,
    ...overrides,
  };
}

const STATES: Array<{ name: string; about: string; xcode: UseXcodeBuildReturn }> = [
  {
    name: 'ready',
    about: 'A scheme and an iOS simulator are chosen, nothing is running yet',
    xcode: xcode(),
  },
  {
    name: 'loading',
    about: 'Discovery is still scanning for containers',
    xcode: xcode({
      loading: true,
      projects: [],
      selectedContainerPath: null,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      selectedDestination: null,
    }),
  },
  {
    name: 'error',
    about: 'Discovery failed and the bar explains why',
    xcode: xcode({
      error: 'xcodebuild is unavailable',
      projects: [],
      selectedContainerPath: null,
      schemes: [],
      selectedScheme: null,
      destinations: [],
      selectedDestination: null,
    }),
  },
  {
    name: 'flutter',
    about: 'A Flutter app is launched, so hot reload and hot restart are offered',
    xcode: xcode({
      build: buildState({ phase: 'launched', supportsHotReload: true }),
      outputExpanded: false,
    }),
  },
  {
    name: 'native',
    about: 'A native app is launched: no hot channel, so the play button rebuilds it',
    xcode: xcode({ build: buildState({ phase: 'launched', supportsHotReload: false }) }),
  },
  {
    name: 'failed',
    about: 'A finished build reports failure through the state icon',
    xcode: xcode({
      build: buildState({ status: 'failed', phase: null, exitCode: 65, endedAt: 1 }),
    }),
  },
];

const OUTPUT = [
  'Build settings from command line:',
  '    SDKROOT = iphonesimulator18.0',
  '',
  'Compile Swift sources normal arm64',
  'Signing Runner.app',
  'Installing Runner.app',
  'Launching Runner',
].join('\n');

function OutputPanel() {
  return (
    <div className="flex h-screen w-full flex-col bg-sidebar p-2">
      <section data-case="output" className="flex w-full flex-col">
        <XcodeBuildOutput
          build={buildState({ phase: 'launched', supportsHotReload: true })}
          output={OUTPUT}
          expanded
          onToggle={() => undefined}
        />
      </section>
    </div>
  );
}

function ToolbarStates() {
  return (
    <div className="flex h-screen w-full flex-col gap-2 bg-sidebar p-2">
      {STATES.map((state) => (
        <section
          key={state.name}
          data-case={state.name}
          className="flex w-full items-center justify-end border-t border-[var(--cmd-palette-border)] py-1"
        >
          <XcodeBuildToolbar xcode={state.xcode} />
        </section>
      ))}
    </div>
  );
}

mountPage({
  // The bar owns no data of its own; every value it renders is a prop fixture.
  host: () => ({}),
  render: (ctx) => (ctx.case === 'output' ? <OutputPanel /> : <ToolbarStates />),
});
