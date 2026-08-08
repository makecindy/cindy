import { describe, expect, it, vi } from 'vitest';

import {
  makeDialogueNewMakerRouteState,
  readNewMakerDialogueTargetRequest,
} from '@/features/cc-agent/lib/newMakerRouteState';

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
});
