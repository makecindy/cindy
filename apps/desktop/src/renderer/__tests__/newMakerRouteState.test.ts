import { describe, expect, it, vi } from 'vitest';

import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerFolderPickerRequest,
  makeDialogueNewMakerRouteState,
  makeFolderPickerNewMakerRouteState,
  isSameNewMakerDevice,
  readNewMakerDialogueTargetRequest,
  readNewMakerFolderPickerRequest,
  shouldPrefillDefaultNewTaskWorkingDir,
} from '@/features/cc-agent/lib/newMakerRouteState';

describe('default directory for a new local task', () => {
  const emptyLocalDraft = { workingDir: null, remoteHostId: null, deviceLinkDeviceId: null };

  it('fills a generic local draft and yields to an explicitly chosen project', () => {
    expect(
      shouldPrefillDefaultNewTaskWorkingDir({ workspacePrompt: 'generic' }, emptyLocalDraft),
    ).toBe(true);
    expect(shouldPrefillDefaultNewTaskWorkingDir(null, emptyLocalDraft)).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        { workspacePrompt: 'generic' },
        { ...emptyLocalDraft, explicitNoProject: true },
      ),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        { workspacePrompt: 'generic' },
        {
          ...emptyLocalDraft,
          workingDir: '/chosen-project',
        },
      ),
    ).toBe(false);
  });

  it('does not replace a dialogue or a remote target', () => {
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(makeDialogueNewMakerRouteState(null), emptyLocalDraft),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(
        {
          workspacePrompt: 'generic',
          dialogueTargetRequest: {
            requestId: 'remote',
            deviceId: 'computer-a',
            deviceName: 'Computer A',
          },
        },
        emptyLocalDraft,
      ),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(null, {
        ...emptyLocalDraft,
        remoteHostId: 'ssh-a',
      }),
    ).toBe(false);
    expect(
      shouldPrefillDefaultNewTaskWorkingDir(null, {
        ...emptyLocalDraft,
        deviceLinkDeviceId: 'computer-a',
      }),
    ).toBe(false);
  });
});

describe('new maker execution device identity', () => {
  it.each([
    {
      label: 'local',
      deviceLinkDeviceId: null,
      remoteHostId: null,
      expected: [true, false, false],
    },
    {
      label: 'remote A',
      deviceLinkDeviceId: 'a',
      remoteHostId: null,
      expected: [false, true, false],
    },
    {
      label: 'remote B',
      deviceLinkDeviceId: 'b',
      remoteHostId: null,
      expected: [false, false, true],
    },
    {
      label: 'SSH',
      deviceLinkDeviceId: null,
      remoteHostId: 'ssh-a',
      expected: [false, false, false],
    },
  ])('preserves only the matching execution target for $label drafts', ({ expected, ...draft }) => {
    expect([null, 'a', 'b'].map((deviceId) => isSameNewMakerDevice(deviceId, draft))).toEqual(
      expected,
    );
  });

  it('distinguishes SSH and local even when a folder path is reused', () => {
    const draft = {
      deviceLinkDeviceId: null,
      remoteHostId: 'ssh-a' as string | null,
      workingDir: '/project',
    };
    expect(isSameNewMakerDevice(null, draft)).toBe(false);
    draft.remoteHostId = null;
    expect(isSameNewMakerDevice(null, draft)).toBe(true);
    draft.remoteHostId = 'ssh-b';
    expect(isSameNewMakerDevice(null, draft)).toBe(false);
  });
});

describe('new maker dialogue route target request', () => {
  it('encodes remote and local dialogue targets', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const remote = makeDialogueNewMakerRouteState({
      deviceId: 'remote-a',
      deviceName: 'Remote A',
    });
    const local = makeDialogueNewMakerRouteState(null);

    expect(readNewMakerDialogueTargetRequest(remote)).toMatchObject({
      deviceId: 'remote-a',
      deviceName: 'Remote A',
    });
    expect(readNewMakerDialogueTargetRequest(local)).toMatchObject({
      deviceId: null,
      deviceName: null,
    });
  });

  it('generates a fresh request for repeated navigation to an already-mounted route', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const first = readNewMakerDialogueTargetRequest(makeDialogueNewMakerRouteState(null));
    const second = readNewMakerDialogueTargetRequest(makeDialogueNewMakerRouteState(null));
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('rejects malformed route state instead of guessing a target', () => {
    expect(readNewMakerDialogueTargetRequest(null)).toBeNull();
    expect(readNewMakerDialogueTargetRequest({ dialogueTargetRequest: {} })).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad',
          deviceId: null,
          deviceName: 'orphan-name',
        },
      }),
    ).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad-local-dir',
          deviceId: null,
          deviceName: null,
          workingDir: '/remote/project',
        },
      }),
    ).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad-local-dialogue',
          deviceId: null,
          deviceName: null,
          explicitNoProject: true,
        },
      }),
    ).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad-conflict',
          deviceId: 'remote-a',
          deviceName: 'Remote A',
          workingDir: '/remote/project',
          explicitNoProject: true,
        },
      }),
    ).toBeNull();
    expect(
      readNewMakerDialogueTargetRequest({
        dialogueTargetRequest: {
          requestId: 'bad-blank-dir',
          deviceId: 'remote-a',
          deviceName: 'Remote A',
          workingDir: '   ',
        },
      }),
    ).toBeNull();
  });

  // 测试价值:
  // - 生产入口与可观察结果: readNewMakerDialogueTargetRequest；验证远程目标携带的 workingDir 或
  //   explicitNoProject 会完整透传给新建页消费，且不允许把远程目录或冲突标记绑定到本机目标。
  // - Bug／规则依据: PR #13368 review (P1)，跨窗口打开通用新建时需要保留源窗口远程草稿的项目与仅对话选择。
  // - 现有覆盖缺口: 此前仅校验 deviceId / deviceName / preserveWorkspaceIfSameDevice，未覆盖远程草稿工作区透传字段。
  // - 最小失败输入: 带 workingDir 或 explicitNoProject 的远程 dialogueTargetRequest。
  // - tier: unit（纯函数）。
  it('preserves validated remote workingDir and explicitNoProject hints on dialogueTargetRequest', () => {
    expect(
      readNewMakerDialogueTargetRequest({
        workspacePrompt: 'generic',
        dialogueTargetRequest: {
          requestId: 'remote-dir',
          deviceId: 'remote-a',
          deviceName: 'Remote A',
          preserveWorkspaceIfSameDevice: true,
          workingDir: '/remote/project',
        },
      }),
    ).toEqual({
      requestId: 'remote-dir',
      deviceId: 'remote-a',
      deviceName: 'Remote A',
      preserveWorkspaceIfSameDevice: true,
      workingDir: '/remote/project',
    });

    expect(
      readNewMakerDialogueTargetRequest({
        workspacePrompt: 'generic',
        dialogueTargetRequest: {
          requestId: 'remote-dialogue',
          deviceId: 'remote-a',
          deviceName: 'Remote A',
          preserveWorkspaceIfSameDevice: true,
          explicitNoProject: true,
        },
      }),
    ).toEqual({
      requestId: 'remote-dialogue',
      deviceId: 'remote-a',
      deviceName: 'Remote A',
      preserveWorkspaceIfSameDevice: true,
      explicitNoProject: true,
    });
  });

  it('consumes an applied target request without changing the original or other route state', () => {
    const original = {
      workspacePrompt: 'dialogue',
      dialogueTargetRequest: {
        requestId: 'request-a',
        deviceId: 'remote-a',
        deviceName: 'Remote A',
      },
      preserved: { source: 'sidebar' },
    };

    const consumed = consumeNewMakerDialogueTargetRequest(original);

    expect(consumed).toEqual({
      workspacePrompt: 'dialogue',
      preserved: { source: 'sidebar' },
    });
    expect(readNewMakerDialogueTargetRequest(consumed)).toBeNull();
    expect(readNewMakerDialogueTargetRequest(original)).toMatchObject({
      requestId: 'request-a',
      deviceId: 'remote-a',
    });
  });

  it('leaves unrelated or non-object history state untouched', () => {
    const unrelated = { workspacePrompt: 'generic' };
    expect(consumeNewMakerDialogueTargetRequest(unrelated)).toBe(unrelated);
    expect(consumeNewMakerDialogueTargetRequest(null)).toBeNull();
  });
});

describe('new maker folder picker request', () => {
  it('opens the picker again when the same route is already mounted', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5678);
    const first = readNewMakerFolderPickerRequest(makeFolderPickerNewMakerRouteState());
    const second = readNewMakerFolderPickerRequest(makeFolderPickerNewMakerRouteState());
    expect(first?.requestId).toBeTruthy();
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it('consumes a folder picker request without dropping other route state', () => {
    const original = {
      workspacePrompt: 'generic',
      folderPickerRequest: { requestId: 'picker-1' },
      preserved: true,
    };
    const consumed = consumeNewMakerFolderPickerRequest(original);
    expect(consumed).toEqual({ workspacePrompt: 'generic', preserved: true });
    expect(readNewMakerFolderPickerRequest(consumed)).toBeNull();
    expect(readNewMakerFolderPickerRequest(original)).toEqual({ requestId: 'picker-1' });
  });
});
