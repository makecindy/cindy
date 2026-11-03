import { describe, expect, it, vi } from 'vitest';

import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerFolderPickerRequest,
  makeDialogueNewMakerRouteState,
  makeFolderPickerNewMakerRouteState,
  isSameNewMakerDevice,
  readNewMakerDialogueTargetRequest,
  readNewMakerFolderPickerRequest,
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
