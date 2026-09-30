// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import {
  projectMakeRemoteCard,
  type MakeRemoteSnapshot,
} from '../../../../main/cindy-make/remoteProjection';
import type { MakeDoctorReport } from '../../../../shared/cindyMakeDoctor';
import { SessionResourceCards } from '../SessionResourceCards';
import {
  parseSessionResource,
  sessionResourceCollections,
  sessionResourceInputBlocked,
} from '../sessionResources';
import type { useSessionResourceCards } from '../useSessionResourceCards';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

afterEach(cleanup);
const base: MakeRemoteSnapshot = {
  sessionId: 'remote-task',
  revision: '1',
  busy: false,
  recoverable: false,
};
const completion = { id: 'completion', meta: { reportedAt: 100, commit: 'abc' } };
const prep: MakeDoctorReport = {
  runId: 'preparation',
  status: 'running',
  checks: [],
  platform: 'win32',
  arch: 'x64',
  task: { sessionId: base.sessionId, phase: 'dependencies' },
};
const locales = [
  ['en', en],
  ['zh-CN', zhCN],
  ['zh-TW', zhTW],
  ['ja', ja],
  ['ko', ko],
] as const;
const phases = [
  {
    name: 'preparing',
    snapshot: { preparation: prep },
    blocked: true,
    action: 'cindyMake.history.stop',
  },
  {
    name: 'preparation failure',
    snapshot: { preparation: { ...prep, status: 'failed' as const } },
    blocked: true,
    action: 'cindyMake.history.actions.retry-prepare',
  },
  { name: 'test handoff', snapshot: { completion }, blocked: true, action: 'cindyMake.test.start' },
  {
    name: 'test startup',
    snapshot: {
      completion: {
        ...completion,
        meta: {
          ...completion.meta,
          test: { status: 'starting' as const, step: 'dependencies' as const },
        },
      },
    },
    blocked: true,
    action: 'cindyMake.test.continue',
    disabled: true,
  },
  {
    name: 'personal build',
    snapshot: {
      completion: {
        ...completion,
        meta: {
          ...completion.meta,
          personal: { buildId: 'build', status: 'packaging' as const },
          lastAction: 'build' as const,
        },
      },
    },
    blocked: true,
    action: 'cindyMake.history.stop',
  },
  {
    name: 'editing recovery',
    snapshot: { recoverable: true },
    blocked: false,
    action: 'cindyMake.test.start',
  },
];

it.each(locales)(
  'renders host workflow phases and recovery controls in %s',
  async (locale, strings) => {
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      resources: { [locale]: { translation: strings } },
    });
    for (const phase of phases) {
      const wire = projectMakeRemoteCard(
        { ...base, ...phase.snapshot } as MakeRemoteSnapshot,
        (key, values) => String(i18n.t(key, values)),
      );
      const resource = parseSessionResource(wire, wire.ref);
      const act = vi.fn();
      const state: ReturnType<typeof useSessionResourceCards> = {
        resources: [resource],
        supported: true,
        handlesSession: true,
        fresh: true,
        readOnly: false,
        connected: true,
        pending: null,
        failed: false,
        blocked: sessionResourceInputBlocked([resource]),
        refresh: vi.fn(),
        act,
      };
      expect(state.blocked, phase.name).toBe(phase.blocked);
      const view = render(
        <I18nextProvider i18n={i18n}>
          <SessionResourceCards state={state} />
        </I18nextProvider>,
      );
      const button = screen.getByRole('button', {
        name: String(i18n.t(phase.action)),
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(phase.disabled ?? false);
      fireEvent.click(button);
      expect(act).toHaveBeenCalledTimes(phase.disabled ? 0 : 1);
      expect(view.container.textContent).not.toMatch(/cindyMake[.]|cindyMakeDoctor[.]|�/);
      view.unmount();
    }
  },
);

it('shows unknown primitives as inert readable text and disables stale actions', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
  const wire = projectMakeRemoteCard({ ...base, completion }, (key) => key);
  wire.blocks = [
    {
      id: 'future',
      primitive: 'future-progress',
      fallbackMarkdown: '<script>do not execute</script>',
      data: { private: 'not needed' },
    },
  ];
  const resource = parseSessionResource(wire, wire.ref);
  const state: ReturnType<typeof useSessionResourceCards> = {
    resources: [resource],
    supported: true,
    handlesSession: true,
    fresh: false,
    readOnly: false,
    connected: false,
    pending: null,
    failed: false,
    blocked: true,
    act: vi.fn(),
    refresh: vi.fn(),
  };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SessionResourceCards state={state} />
    </I18nextProvider>,
  );
  expect(screen.getByText('<script>do not execute</script>')).toBeTruthy();
  expect(view.container.querySelector('script')).toBeNull();
  expect(screen.getByText(en.cindyMake.remote.offline)).toBeTruthy();
  for (const button of screen.getAllByRole('button'))
    expect((button as HTMLButtonElement).disabled).toBe(true);
});

it('validates resource identity, preserves unknown block fallback, and never drops required action inputs or confirmation', () => {
  const wire = projectMakeRemoteCard({ ...base, completion }, (key) => key);
  expect(() => parseSessionResource(wire, { ...wire.ref, id: 'other-task' })).toThrow();
  const raw = {
    ...wire,
    actions: [
      { id: 'form', label: 'Form', fields: [{ id: 'required', required: true }] },
      { id: 'broken-confirmation', label: 'Stop', confirmation: {} },
      { id: 'disabled', label: 'Disabled', disabled: true },
    ],
    blocks: [
      {
        id: 'controls',
        primitive: 'session-controls',
        fallbackMarkdown: 'Unknown input state',
        data: {},
      },
    ],
  };
  const parsed = parseSessionResource(raw, wire.ref);
  expect(parsed.actions.map((action) => action.id)).toEqual(['disabled']);
  expect(sessionResourceInputBlocked([parsed])).toBe(true);
  expect(
    sessionResourceCollections(
      {
        protocolVersion: 1,
        collections: [
          { id: 'other', resourceKind: 'bot', placement: 'home-scope' },
          { unrecognized: true },
          { id: 'make', resourceKind: 'session', placement: 'session:cindy-make' },
        ],
      },
      'cindy-make',
    ),
  ).toEqual([{ id: 'make', resourceKind: 'session', placement: 'session:cindy-make' }]);
});
