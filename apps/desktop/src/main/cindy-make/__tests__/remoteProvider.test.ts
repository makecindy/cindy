import { describe, expect, it, vi } from 'vitest';
import { projectMakeRemoteCard, makeRemoteRef, type MakeRemoteSnapshot } from '../remoteProjection';
import { createMakeRemoteProvider } from '../remoteProvider';
import { RemoteResourceRegistry } from '../../device-link/remoteResourceRegistry';
import en from '../../../renderer/i18n/locales/en/common.json';
import zh from '../../../renderer/i18n/locales/zh-CN/common.json';
import tw from '../../../renderer/i18n/locales/zh-TW/common.json';
import ja from '../../../renderer/i18n/locales/ja/common.json';
import ko from '../../../renderer/i18n/locales/ko/common.json';

const context = { controllerDeviceId: 'phone' };
const client = { protocolVersion: 1, primitives: ['session-controls'], locale: 'en' };
const snapshot = (): MakeRemoteSnapshot => ({
  sessionId: 'task',
  revision: 'revision',
  busy: false,
  recoverable: false,
  completion: { id: 'done', meta: { reportedAt: 1, commit: 'a'.repeat(40) } },
});
const project = (state: MakeRemoteSnapshot, dictionary: Record<string, unknown> = en) =>
  projectMakeRemoteCard(state, (key, values) => {
    const text = key
      .split('.')
      .reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], dictionary);
    expect(typeof text, key).toBe('string');
    return Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll('{{' + name + '}}', value),
      text as string,
    );
  });

describe('portable Cindy Make cards', () => {
  it.each([en, zh, tw, ja, ko])(
    'translates preparation, test steps, failure and recovery without leaking local details',
    (dictionary) => {
      const state = snapshot();
      state.preparation = {
        runId: 'run',
        platform: 'win32',
        arch: 'x64',
        status: 'running',
        checks: [
          {
            id: 'node',
            status: 'downloading',
            path: 'C:/private/tool',
            progress: { loaded: 5, total: 10, percent: 50 },
          },
        ],
        task: {
          sessionId: 'task',
          phase: 'dependencies',
          request: 'private prompt',
          dependencies: { added: 2 },
        },
      };
      const prep = project(state, dictionary);
      expect(prep.blocks?.[0].data).toMatchObject({ input: 'blocked', busy: true });
      expect(prep.actions?.[0].id).toBe('prepare:run:stop');
      expect(JSON.stringify(prep)).not.toContain('private');
      expect(prep.blocks?.[0].fallbackMarkdown).toContain('50%');
      state.preparation.status = 'failed';
      state.preparation.task!.phase = 'completed';
      expect(project(state, dictionary).actions?.[0].id).toBe('prepare:run:retry');
      delete state.preparation;
      state.completion!.meta.test = { status: 'starting', step: 'dependencies' };
      const starting = project(state, dictionary);
      expect(starting.actions?.every((action) => action.disabled)).toBe(true);
      expect(starting.blocks?.[0].data).toMatchObject({ input: 'blocked', busy: true });
      state.completion!.meta.test = {
        status: 'failed',
        step: 'dependencies',
        error: 'environment',
      };
      const failed = project(state, dictionary);
      expect(failed.display.status?.tone).toBe('critical');
      expect(failed.actions?.find((action) => action.id === 'test:done:start')?.disabled).toBe(
        false,
      );
      state.completion!.meta.continuedAt = 2;
      state.recoverable = true;
      const resumed = project(state, dictionary);
      expect(resumed.blocks?.[0].data).toMatchObject({ input: 'available' });
      expect(resumed.actions?.map((action) => action.id)).toEqual(['resume:revision']);
    },
  );

  it('locks editing during the shared build and identifies the exact build to stop', () => {
    const state = snapshot();
    state.sharedBuild = {
      buildId: 'build',
      status: 'checking',
      checkStep: 'dependencies',
      logs: [{ step: 'merging', at: 1 }, { step: 'checking-dependencies', at: 2 }],
    };
    const card = project(state);
    expect(card.actions?.slice(0, 3).every((action) => action.disabled)).toBe(true);
    expect(card.actions?.at(-1)).toMatchObject({ id: 'build:build:stop', disabled: false });
    expect(card.blocks?.[0].fallbackMarkdown).toContain(en.cindyMake.personal.buildLog.title);
    expect(card.blocks?.[0].fallbackMarkdown).toContain(
      en.cindyMake.personal.buildLog.steps['checking-dependencies'],
    );
    state.sharedBuild.stopping = true;
    expect(project(state).actions?.at(-1)?.disabled).toBe(true);
  });

  it('keeps the current test visible over an older build receipt', () => {
    const state = snapshot();
    state.completion!.meta.lastAction = 'test';
    state.completion!.meta.test = { status: 'starting', step: 'launching' };
    state.sharedBuild = { status: 'ready', buildId: 'old' };
    expect(project(state).display.title).toBe(en.cindyMake.test.status.starting);
    state.busy = true;
    expect(project(state).actions).toEqual([]);
    expect(project(state).blocks).toEqual([]);
  });
});

describe('host validates portable task actions', () => {
  function harness() {
    const state = snapshot();
    let current = true;
    const act = vi.fn(async () => {});
    const registry = new RemoteResourceRegistry();
    registry.register(
      createMakeRemoteProvider({
        load: async () => ({ snapshot: state, isCurrent: () => current }),
        translate: (_locale, key) => key,
        act,
      }),
    );
    const invoke = (actionId: string) =>
      registry.invoke(context, {
        client,
        collectionId: 'cindy-make',
        resourceRef: makeRemoteRef('task'),
        actionId,
      });
    return {
      state,
      act,
      registry,
      invoke,
      changeOwner: () => {
        current = false;
      },
    };
  }
  it('rejects stale completion, arbitrary actions and disabled startup actions', async () => {
    const h = harness();
    await expect(h.invoke('test:previous:start')).rejects.toThrow('Task changed');
    await expect(h.invoke('delete-everything')).rejects.toThrow('Task changed');
    h.state.completion!.meta.test = { status: 'starting' };
    await expect(h.invoke('test:done:continue')).rejects.toThrow('Task changed');
    expect(h.act).not.toHaveBeenCalled();
  });
  it('does not dispatch a prior owner or a superseded recovery revision', async () => {
    const h = harness();
    h.state.completion = undefined;
    h.state.recoverable = true;
    await expect(h.invoke('resume:old')).rejects.toThrow('Task changed');
    h.changeOwner();
    await expect(h.invoke('resume:revision')).rejects.toThrow('Task changed');
    expect(h.act).not.toHaveBeenCalled();
  });
  it('coalesces two controllers and returns only invalidation effects', async () => {
    const h = harness();
    let finish!: () => void;
    h.act.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.invoke('test:done:start');
    await vi.waitFor(() => expect(h.act).toHaveBeenCalledOnce());
    await expect(h.invoke('test:done:start')).rejects.toThrow('already running');
    finish();
    await expect(first).resolves.toEqual({
      effects: [{ kind: 'refresh-resource', ref: makeRemoteRef('task') }],
    });
    expect(h.act).toHaveBeenCalledOnce();
  });
  it('rejects resources outside the registered kind', async () => {
    const h = harness();
    await expect(
      h.registry.invoke(context, {
        client,
        collectionId: 'cindy-make',
        resourceRef: { ...makeRemoteRef('task'), kind: 'bot' },
        actionId: 'test:done:start',
      }),
    ).rejects.toThrow('does not exist');
    expect(h.act).not.toHaveBeenCalled();
  });
});
