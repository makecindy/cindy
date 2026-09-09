import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedCommand } from '@cindy/maker-core';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const h = vi.hoisted(() => ({ ensureTask: vi.fn(), start: vi.fn(), load: vi.fn() }));
vi.mock('@/lib/cindyMakeDoctorStream', () => ({
  ensureMakeTask: h.ensureTask,
  startMakeDoctorInStream: h.start,
}));
vi.mock('@/lib/slashCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/slashCommands')>()),
  loadAllCommands: h.load,
}));

import {
  classifyCindyMakeCommand,
  tryStartCindyMakeCommand,
  type CindyMakeCommandInput,
} from '../cindyMakeCommand';

const commands: UnifiedCommand[] = [
  { name: 'cindy-make', kind: 'desktop', description: 'Start a personal build' },
  { name: 'cindy-make-doctor', kind: 'desktop', description: 'Check tools' },
];
function input(overrides: Partial<CindyMakeCommandInput> = {}): CindyMakeCommandInput {
  return {
    text: '/cindy-make fix scrolling',
    commands,
    sessionId: 'source-task',
    deviceId: null,
    hasUnsupportedContent: false,
    isCurrent: () => true,
    createOptions: { workspaceKind: 'dialogue' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setDataOwnerGeneration('test-owner');
  h.ensureTask.mockResolvedValue('source-task');
  h.start.mockReturnValue('run');
  h.load.mockResolvedValue(commands);
});
afterEach(() => setDataOwnerGeneration(null));

describe('explicit Make command ownership', () => {
  it.each([
    'fix Cindy and build my version',
    '请检查环境',
    'cindy-make',
    'cindy-make-doctor',
    'explain /cindy-make',
    '/cindy-maker',
    '/cindy-make-extra',
    '/cindy-make-doctor-extra',
    '`/cindy-make`',
    ' /cindy-make',
    '> /cindy-make',
    '```\n/cindy-make\n```',
  ])('leaves ordinary input untouched: %s', async (text) => {
    expect(classifyCindyMakeCommand(text, null)).toEqual({ kind: 'none' });
    expect(await tryStartCindyMakeCommand(input({ text, commands: null }))).toEqual({
      kind: 'none',
    });
    expect(h.ensureTask).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['/cindy-make', '/CINDY-MAKE\n', '/cindy-make  \t '])(
    'requires a request before starting Make: %s',
    (text) => {
      expect(classifyCindyMakeCommand(text, commands)).toEqual({
        kind: 'usage',
        command: 'cindy-make',
      });
    },
  );

  it('preserves a multiline request verbatim, including spacing and slash text', () => {
    const request = '  修复跳动\n保留 /help 示例与 <b>文本</b>  ';
    expect(classifyCindyMakeCommand(`/CINDY-MAKE ${request}`, commands)).toEqual({
      kind: 'start',
      invocation: { command: 'cindy-make', request },
    });
  });

  it('allows whitespace but no request after standalone Doctor', () => {
    expect(classifyCindyMakeCommand('/CINDY-MAKE-DOCTOR\n', commands)).toEqual({
      kind: 'start',
      invocation: { command: 'cindy-make-doctor' },
    });
    expect(classifyCindyMakeCommand('/cindy-make-doctor fix a bug', commands)).toEqual({
      kind: 'usage',
      command: 'cindy-make-doctor',
    });
  });

  it.each(['cindy-make', 'cindy-make-doctor'])(
    'preserves same-name Skill priority for %s',
    async (name) => {
      const skill: UnifiedCommand = { name, kind: 'agent-skill', source: 'skill' };
      expect(
        await tryStartCindyMakeCommand(input({ text: `/${name}`, commands: [skill] })),
      ).toEqual({ kind: 'none' });
      expect(h.ensureTask).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it.each([null, []])('blocks a temporarily missing catalog: %j', async (roster) => {
    expect(await tryStartCindyMakeCommand(input({ commands: roster }))).toEqual({
      kind: 'blocked',
      messageKey: 'cindyMakeDoctor.commandUnavailable',
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['cindy-make', 'cindy-make-doctor'])(
    'reconciles a late Pi Skill before starting %s',
    async (name) => {
      h.load.mockResolvedValue([
        { name, kind: 'agent-skill', source: 'skill', runtimeStatus: 'loaded' },
      ]);
      expect(await tryStartCindyMakeCommand(input({ text: `/${name}`, agentKind: 'pi' }))).toEqual({
        kind: 'none',
      });
      expect(h.load).toHaveBeenCalledWith(
        'pi',
        undefined,
        {
          sessionId: 'source-task',
          skipAgentSkills: false,
          forceReload: true,
        },
        undefined,
      );
      expect(h.ensureTask).not.toHaveBeenCalled();
    },
  );
});

describe('native environment-check entry', () => {
  it.each([
    {
      text: '/cindy-make fix scrolling',
      invocation: { command: 'cindy-make', request: 'fix scrolling' },
    },
    {
      text: '/cindy-make fix scrolling',
      invocation: { command: 'cindy-make', request: 'fix scrolling' },
    },
    { text: '/cindy-make-doctor', invocation: { command: 'cindy-make-doctor' } },
  ])(
    'starts the same diagnostics without a connected model: $text',
    async ({ text, invocation }) => {
      expect(await tryStartCindyMakeCommand(input({ text, agentKind: null }))).toEqual({
        kind: 'started',
        sessionId: 'source-task',
      });
      expect(h.ensureTask).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'source-task' }),
      );
      expect(h.start).toHaveBeenCalledExactlyOnceWith('source-task', invocation);
    },
  );

  it('passes home preferences only to task creation and returns its navigation target', async () => {
    h.ensureTask.mockResolvedValue('home-task');
    const createOptions = {
      workspaceKind: 'dialogue',
      agentKind: 'codex',
      model: 'selected-model',
      effort: 'high',
      permissionMode: 'auto',
      providerId: 'provider',
      fastMode: true,
      planModeEnabled: true,
    } as const;
    expect(await tryStartCindyMakeCommand(input({ sessionId: undefined, createOptions }))).toEqual({
      kind: 'started',
      sessionId: 'home-task',
    });
    expect(h.ensureTask).toHaveBeenCalledWith({
      sessionId: undefined,
      createOptions,
      isCurrent: expect.any(Function),
    });
    expect(h.start).toHaveBeenCalledWith('home-task', {
      command: 'cindy-make',
      request: 'fix scrolling',
    });
  });

  it.each(['cindy-make', 'cindy-make-doctor'])(
    'rejects unsupported content without starting or creating a task: %s',
    async (name) => {
      expect(
        await tryStartCindyMakeCommand(input({ text: `/${name}`, hasUnsupportedContent: true })),
      ).toEqual({
        kind: 'blocked',
        messageKey: `${name === 'cindy-make' ? 'cindyMake' : 'cindyMakeDoctor'}.usage`,
      });
      expect(h.ensureTask).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('rejects Doctor arguments without losing them to a normal send', async () => {
    expect(await tryStartCindyMakeCommand(input({ text: '/cindy-make-doctor fix it' }))).toEqual({
      kind: 'blocked',
      messageKey: 'cindyMakeDoctor.usage',
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([{ deviceId: 'other-device' }, { remoteHostId: 'ssh-host' }, { deviceId: undefined }])(
    'rejects remote or unresolved ownership: %j',
    async (origin) => {
      expect(await tryStartCindyMakeCommand(input(origin))).toEqual({
        kind: 'blocked',
        messageKey: 'cindyMake.localOnly',
      });
      expect(h.ensureTask).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('does not create a task from a stale source', async () => {
    expect(await tryStartCindyMakeCommand(input({ isCurrent: () => false }))).toEqual({
      kind: 'stale',
    });
    expect(h.ensureTask).not.toHaveBeenCalled();
  });

  it.each(['view', 'account'])(
    'does not start after a %s switch during creation',
    async (boundary) => {
      let current = true;
      h.ensureTask.mockImplementation(async () => {
        if (boundary === 'account') setDataOwnerGeneration('different-owner');
        else current = false;
        return 'late-task';
      });
      expect(await tryStartCindyMakeCommand(input({ isCurrent: () => current }))).toEqual({
        kind: 'stale',
      });
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('returns a sanitized failure if task creation fails', async () => {
    h.ensureTask.mockRejectedValue(new Error('private error details'));
    expect(await tryStartCindyMakeCommand(input())).toEqual({ kind: 'failed' });
    expect(h.start).not.toHaveBeenCalled();
  });
});
