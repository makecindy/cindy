import { describe, expect, it, vi } from 'vitest';

import { readCreateSessionOpts, withCreateSessionStderr } from '../sessionRequest';

describe('session IPC request parsing', () => {
  it('reads create-session required fields and preserves opaque options', () => {
    const opts = readCreateSessionOpts({
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      workspaceKind: 'dialogue',
      extraDirs: ['D:\\refs'],
      vendorOptions: { source: 'draft' },
    });

    expect(opts).toMatchObject({
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      workspaceKind: 'dialogue',
      extraDirs: ['D:\\refs'],
      vendorOptions: { source: 'draft' },
    });
  });

  it('rejects invalid create-session required fields before Maker side effects', () => {
    expect(() => readCreateSessionOpts(null)).toThrow('[INVALID_PARAMS]');
    expect(() =>
      readCreateSessionOpts({
        agentKind: 'cc',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      readCreateSessionOpts({
        agentKind: 'codex',
        workingDir: '',
        model: 'gpt-5.4',
      }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      readCreateSessionOpts({
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: '',
      }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      readCreateSessionOpts({
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
        workspaceKind: 'scratch',
      }),
    ).toThrow('[INVALID_PARAMS]');
  });

  it('allocates a controlled-side cwd for folderless dialogue sessions when wired by the host', () => {
    const allocateDialogueWorkspace = vi.fn((sessionId: string, nowMs: number) =>
      `/userData/dialogues/${nowMs}/${sessionId}`,
    );

    const opts = readCreateSessionOpts({
      agentKind: 'codex',
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
    }, {
      allocateDialogueWorkspace,
      createSessionId: () => 'generated-session-id',
      now: () => 1710000000000,
    });

    expect(allocateDialogueWorkspace).toHaveBeenCalledWith(
      'generated-session-id',
      1710000000000,
    );
    expect(opts).toMatchObject({
      id: 'generated-session-id',
      agentKind: 'codex',
      workspaceKind: 'dialogue',
      workingDir: '/userData/dialogues/1710000000000/generated-session-id',
      model: 'gpt-5.4',
    });
  });

  it('accepts a caller-supplied safe basename id for a dialogue workspace', () => {
    const allocateDialogueWorkspace = vi.fn((sessionId: string) => `/userData/dialogues/d/${sessionId}`);
    const opts = readCreateSessionOpts({
      agentKind: 'codex',
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
      id: 'caller-supplied-id',
    }, { allocateDialogueWorkspace, createSessionId: () => 'unused', now: () => 1710000000000 });
    expect(allocateDialogueWorkspace).toHaveBeenCalledWith('caller-supplied-id', 1710000000000);
    expect(opts.id).toBe('caller-supplied-id');
  });

  it('rejects path-traversal / separator ids for dialogue workspaces (no escaping the dialogue root)', () => {
    const allocateDialogueWorkspace = vi.fn(() => '/dialogue');
    for (const id of ['../../etc/passwd', '..', 'a/b', 'a\\b', '.', 'foo/../bar']) {
      expect(() =>
        readCreateSessionOpts({
          agentKind: 'codex',
          workspaceKind: 'dialogue',
          model: 'gpt-5.4',
          id,
        }, { allocateDialogueWorkspace, createSessionId: () => 'unused' }),
      ).toThrow('[INVALID_PARAMS]');
    }
    expect(allocateDialogueWorkspace).not.toHaveBeenCalled();
  });

  it('rejects path-traversal ids for project sessions with an explicit workingDir (codex review)', () => {
    // 项目会话此前直接用 body.id 未校验;device-link 传 `../../..` 会经下游 path.join
    // 逃出 runtimeDir(如 Pi perm-<id>.json)覆盖任意文件。边界统一按安全单段值拒绝。
    for (const id of ['../../../../tmp/x', '..', 'a/b', 'a\\b', '.', 'foo/../bar']) {
      expect(() =>
        readCreateSessionOpts({
          agentKind: 'pi',
          workspaceKind: 'project',
          model: 'claude-sonnet-4-6',
          workingDir: '/repo',
          id,
        }),
      ).toThrow('[INVALID_PARAMS]');
    }
  });

  it('accepts a safe cuid-style id for a project session', () => {
    const opts = readCreateSessionOpts({
      agentKind: 'pi',
      workspaceKind: 'project',
      model: 'claude-sonnet-4-6',
      workingDir: '/repo',
      id: 'clh1a2b3c0000abcd1234wxyz',
    });
    expect(opts.id).toBe('clh1a2b3c0000abcd1234wxyz');
  });

  it('still rejects project sessions without an explicit workingDir', () => {
    expect(() =>
      readCreateSessionOpts({
        agentKind: 'codex',
        workspaceKind: 'project',
        model: 'gpt-5.4',
      }, {
        allocateDialogueWorkspace: () => '/dialogue',
        createSessionId: () => 'generated-session-id',
      }),
    ).toThrow('[INVALID_PARAMS]');
  });

  it('does not allocate a dialogue cwd before base fields are valid', () => {
    const allocateDialogueWorkspace = vi.fn(() => '/dialogue');

    expect(() =>
      readCreateSessionOpts({
        agentKind: 'codex',
        workspaceKind: 'dialogue',
        model: '',
      }, {
        allocateDialogueWorkspace,
        createSessionId: () => 'generated-session-id',
      }),
    ).toThrow('[INVALID_PARAMS]');
    expect(allocateDialogueWorkspace).not.toHaveBeenCalled();
  });

  it('adds a default stderr logger without replacing caller-provided hook', () => {
    const warn = vi.fn();
    const opts = withCreateSessionStderr(
      readCreateSessionOpts({
        agentKind: 'claude-code',
        workingDir: 'C:\\repo',
        model: 'claude-sonnet-4-6',
      }),
      warn,
    );

    (opts.vendorOptions?.onStderrLine as (line: string) => void)(' failed ');
    (opts.vendorOptions?.onStderrLine as (line: string) => void)('   ');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('claude-code', ' failed ');

    const customHook = vi.fn();
    const withCustomHook = withCreateSessionStderr(
      readCreateSessionOpts({
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
        vendorOptions: { onStderrLine: customHook },
      }),
      warn,
    );

    expect(withCustomHook.vendorOptions?.onStderrLine).toBe(customHook);
  });
});
