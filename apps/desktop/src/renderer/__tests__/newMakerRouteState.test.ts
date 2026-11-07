import { describe, expect, it, vi } from 'vitest';

import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerFolderPickerRequest,
  makeDialogueNewMakerRouteState,
  makeFolderPickerNewMakerRouteState,
  isSameNewMakerDevice,
  readNewMakerDialogueTargetRequest,
  readNewMakerFolderPickerRequest,
  consumeNewMakerModelInheritanceRequest,
  isSameNewMakerTaskComputer,
  nextNewMakerModelInheritanceStep,
  readNewMakerModelInheritanceRequest,
} from '@/features/cc-agent/lib/newMakerRouteState';

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

describe('new maker model inheritance request', () => {
  const request = {
    requestId: 'r1',
    vendor: 'codex',
    model: 'gpt-5.5',
    providerId: null,
    effort: 'high',
    fastMode: 'ultrafast',
    agentDeviceId: null,
    taskDeviceId: 'remote-a',
    remoteHostId: null,
  };

  it('reads a well-formed request and rejects malformed axes', () => {
    expect(readNewMakerModelInheritanceRequest({ modelInheritanceRequest: request })).toEqual(
      request,
    );
    for (const bad of [
      { vendor: 'orca' },
      { model: '' },
      { fastMode: 'yes' },
      { providerId: '' },
      { effort: 3 },
      { taskDeviceId: undefined },
    ]) {
      expect(
        readNewMakerModelInheritanceRequest({ modelInheritanceRequest: { ...request, ...bad } }),
      ).toBeNull();
    }
    expect(readNewMakerModelInheritanceRequest(null)).toBeNull();
  });

  it('consumes only the model request', () => {
    const original = { workspacePrompt: 'generic', modelInheritanceRequest: request, other: 1 };
    expect(consumeNewMakerModelInheritanceRequest(original)).toEqual({
      workspacePrompt: 'generic',
      other: 1,
    });
    const unrelated = { workspacePrompt: 'generic' };
    expect(consumeNewMakerModelInheritanceRequest(unrelated)).toBe(unrelated);
  });

  it.each([
    [{ taskDeviceId: null, remoteHostId: null }, {}, true],
    [{ taskDeviceId: null, remoteHostId: null }, { deviceLinkDeviceId: 'remote-a' }, false],
    [{ taskDeviceId: 'remote-a', remoteHostId: null }, { deviceLinkDeviceId: 'remote-a' }, true],
    [{ taskDeviceId: 'remote-a', remoteHostId: null }, { deviceLinkDeviceId: 'remote-b' }, false],
    [{ taskDeviceId: null, remoteHostId: 'ssh-a' }, { remoteHostId: 'ssh-a' }, true],
    [{ taskDeviceId: null, remoteHostId: 'ssh-a' }, { remoteHostId: 'ssh-b' }, false],
    [{ taskDeviceId: null, remoteHostId: 'ssh-a' }, {}, false],
  ])('applies only on the same task computer: %j vs %j', (source, draft, expected) => {
    expect(isSameNewMakerTaskComputer(source, draft)).toBe(expected);
  });
});

describe('new maker model inheritance step', () => {
  const localRequest = {
    vendor: 'cc' as const,
    providerId: null,
    agentDeviceId: null,
    taskDeviceId: null,
    remoteHostId: null,
  };
  const page = {
    draft: { deviceLinkDeviceId: null, remoteHostId: null, agentDeviceId: null },
    sendInFlight: false,
    usesDeviceCatalog: false,
    deviceCatalogSeeded: false,
    deviceSelectionTouched: false,
    availableAgentsLoaded: true,
    vendorAvailable: true,
    localProvidersLoading: false,
  };

  it('switches the Agent computer first and applies only after that catalog is seeded', () => {
    const request = { ...localRequest, agentDeviceId: 'b' };
    expect(nextNewMakerModelInheritanceStep(request, page)).toEqual({
      kind: 'switch-agent-device',
      agentDeviceId: 'b',
    });
    // 换好后的第一帧:B 的目录还没播种，旧目录的清理不能吃掉请求。
    const switched = { ...page, draft: { ...page.draft, agentDeviceId: 'b' }, usesDeviceCatalog: true };
    expect(nextNewMakerModelInheritanceStep(request, switched)).toEqual({ kind: 'wait' });
    // 播种前残留的 touched 标记不算用户在这台电脑上改选。
    expect(
      nextNewMakerModelInheritanceStep(request, { ...switched, deviceSelectionTouched: true }),
    ).toEqual({ kind: 'wait' });
    expect(
      nextNewMakerModelInheritanceStep(request, { ...switched, deviceCatalogSeeded: true }),
    ).toEqual({ kind: 'apply' });
  });

  it('does not judge the Harness by a roster that may still belong to the previous computer', () => {
    // 本机没有 Pi、任务用 B 上的 Pi:换到 B 后、B 的目录播种前不能按清单判 Pi 不可用。
    const request = { ...localRequest, vendor: 'pi' as const, agentDeviceId: 'b' };
    const switched = {
      ...page,
      draft: { ...page.draft, agentDeviceId: 'b' },
      usesDeviceCatalog: true,
      vendorAvailable: false,
    };
    expect(nextNewMakerModelInheritanceStep(request, switched)).toEqual({ kind: 'wait' });
    expect(
      nextNewMakerModelInheritanceStep(request, {
        ...switched,
        deviceCatalogSeeded: true,
        vendorAvailable: true,
      }),
    ).toEqual({ kind: 'apply' });
  });

  it('switches back to the task computer before applying a local-catalog model', () => {
    const fromB = { ...page, draft: { ...page.draft, agentDeviceId: 'b' }, usesDeviceCatalog: true };
    expect(nextNewMakerModelInheritanceStep(localRequest, fromB)).toEqual({
      kind: 'switch-agent-device',
      agentDeviceId: null,
    });
  });

  it('keeps a seeded remote draft that the user already edited', () => {
    const request = { ...localRequest, taskDeviceId: 'a' };
    const remote = {
      ...page,
      draft: { ...page.draft, deviceLinkDeviceId: 'a' },
      usesDeviceCatalog: true,
      deviceCatalogSeeded: true,
    };
    expect(nextNewMakerModelInheritanceStep(request, remote)).toEqual({ kind: 'apply' });
    expect(
      nextNewMakerModelInheritanceStep(request, { ...remote, deviceSelectionTouched: true }),
    ).toEqual({ kind: 'skip' });
  });

  it('waits for local sources only when the task follows default routing', () => {
    const loading = { ...page, localProvidersLoading: true };
    expect(nextNewMakerModelInheritanceStep(localRequest, loading)).toEqual({ kind: 'wait' });
    expect(
      nextNewMakerModelInheritanceStep({ ...localRequest, providerId: 'p1' }, loading),
    ).toEqual({ kind: 'apply' });
  });

  it.each([
    ['another task computer', { draft: { ...page.draft, deviceLinkDeviceId: 'a' } }],
    ['a send in flight', { sendInFlight: true }],
    ['an unavailable Harness', { vendorAvailable: false }],
  ])('skips with %s', (_label, override) => {
    expect(nextNewMakerModelInheritanceStep(localRequest, { ...page, ...override })).toEqual({
      kind: 'skip',
    });
  });

  it('never moves an SSH task to another Agent computer', () => {
    const request = { ...localRequest, vendor: 'codex' as const, remoteHostId: 'ssh-a' };
    const ssh = { ...page, draft: { ...page.draft, remoteHostId: 'ssh-a' } };
    expect(nextNewMakerModelInheritanceStep(request, ssh)).toEqual({ kind: 'apply' });
  });
});
