import { describe, expect, it } from 'vitest';
import {
  captureMobileHistoryAnchor,
  isMobileHistoryAnchorSettled,
  mobileHistoryAnchorCorrectionStatus,
  mobileHistoryPrependUsesAppOwnedAnchor,
  mobileHistoryTopOffsetAdjustment,
  resolveMobileHistoryAnchorOffset,
} from '@/session/messageHistoryAnchor';
import {
  mobileMessageHistoryAnchorIdentity,
  mobileMessageHistoryOnlyExpandedFirstWorkGroup,
  mobileMessageHistoryRowKeyByIdentity,
} from '@/session/messageHistoryAnchorIdentity';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

describe('messageHistoryAnchor', () => {
  it('uses native prepend anchoring on iOS and app-owned anchoring only on Android', () => {
    expect(mobileHistoryPrependUsesAppOwnedAnchor('ios')).toBe(false);
    expect(mobileHistoryPrependUsesAppOwnedAnchor('android')).toBe(true);
    expect(mobileHistoryPrependUsesAppOwnedAnchor('web')).toBe(false);
  });

  it('waits for the native viewport instead of trusting LegendList optimistic scroll state', () => {
    const correction = {
      requestedAfterNativeScrollSequence: 12,
      targetOffset: 11_330,
    };

    // LegendList.getState().scroll may already equal 11_330 here, but no new native onScroll has
    // acknowledged it yet. The transaction must stay locked instead of re-enabling MVCP early.
    expect(mobileHistoryAnchorCorrectionStatus(correction, {
      nativeOffset: 8_000,
      nativeScrollSequence: 12,
    }, 2)).toBe('waiting');
    // A residual native event at the old coordinate is not the command acknowledgment either.
    expect(mobileHistoryAnchorCorrectionStatus(correction, {
      nativeOffset: 8_000,
      nativeScrollSequence: 13,
    }, 2)).toBe('missed');
    expect(mobileHistoryAnchorCorrectionStatus(correction, {
      nativeOffset: 11_329,
      nativeScrollSequence: 14,
    }, 2)).toBe('acknowledged');
  });

  it('captures the first visible row in LegendList coordinates', () => {
    const anchor = captureMobileHistoryAnchor({
      data: [{ key: 'm1' }, { key: 'm2' }, { key: 'm3' }],
      positionAtIndex: (index) => [0, 140, 320][index],
      scroll: 170,
      start: 1,
    }, (item) => item.key);

    expect(anchor).toEqual({
      key: 'm2',
      viewportOffset: -30,
      fallbacks: [
        { key: 'm3', viewportOffset: 150 },
        { key: 'm1', viewportOffset: -170 },
      ],
    });
  });

  it('captures the closest measured row when LegendList has not resolved its visible range', () => {
    expect(captureMobileHistoryAnchor({
      data: [{ key: 'm1' }, { key: 'm2' }],
      positionAtIndex: (index) => [40, 190][index],
      scroll: 170,
      start: -1,
    }, (item) => item.key)).toEqual({
      key: 'm2',
      viewportOffset: 20,
      fallbacks: [{ key: 'm1', viewportOffset: -130 }],
    });
  });

  it('uses logarithmic position lookup and only captures nearby fallback rows', () => {
    const positionReads: number[] = [];
    const data = Array.from({ length: 800 }, (_, index) => ({ key: `m${index}` }));
    const anchor = captureMobileHistoryAnchor({
      data,
      positionAtIndex: (index) => {
        positionReads.push(index);
        return index * 100;
      },
      scroll: 40_050,
      start: -1,
    }, (item) => item.key);

    expect(anchor?.key).toBe('m400');
    expect(anchor?.fallbacks).toHaveLength(7);
    expect(positionReads.length).toBeLessThan(30);
  });

  it('bounds nearby probes when row positions are temporarily unavailable', () => {
    let positionReads = 0;
    const data = Array.from({ length: 800 }, (_, index) => ({ key: `m${index}` }));
    expect(captureMobileHistoryAnchor({
      data,
      positionAtIndex: (index) => {
        positionReads += 1;
        return index === 400 ? 40_000 : undefined;
      },
      scroll: 40_000,
      start: 400,
    }, (item) => item.key)).toEqual({ key: 'm400', viewportOffset: 0 });
    expect(positionReads).toBeLessThanOrEqual(24);
  });

  it('rejects a state with no measured rows', () => {
    expect(captureMobileHistoryAnchor({
      data: [{ key: 'm1' }],
      positionAtIndex: () => undefined,
      scroll: 0,
      start: -1,
    }, (item) => item.key)).toBeNull();
  });

  it('keeps the same row at the same viewport offset after a prepend', () => {
    let identityScans = 0;
    const target = resolveMobileHistoryAnchorOffset(
      { key: 'm80', identityKey: 'leaf-m80', viewportOffset: -30 },
      {
        keyByIdentity: () => {
          identityScans += 1;
          return 'm80';
        },
        positionByKey: (key) => key === 'm80' ? 11_300 : undefined,
      },
    );

    expect(target).toBe(11_330);
    expect(identityScans).toBe(0);
  });

  it('recovers the align-at-end spacer for an under-one-screen list', () => {
    expect(mobileHistoryTopOffsetAdjustment({
      contentLength: 720,
      data: [{ key: 'm1' }, { key: 'm2' }],
      positionAtIndex: (index) => [0, 120][index],
      scrollLength: 720,
      sizeAtIndex: (index) => [96, 168][index],
    }, {
      baseTopOffset: 64,
      bottomPadding: 32,
      footerSize: 0,
    })).toBe(400);
  });

  it('uses the explicit header and padding baseline once content overflows', () => {
    expect(mobileHistoryTopOffsetAdjustment({
      contentLength: 1_200,
      data: [{ key: 'm1' }, { key: 'm2' }],
      positionAtIndex: (index) => [0, 840][index],
      scrollLength: 720,
      sizeAtIndex: (index) => [816, 296][index],
    }, {
      baseTopOffset: 64,
      bottomPadding: 32,
      footerSize: 0,
    })).toBe(64);
  });

  it('re-resolves the target when older row measurements settle', () => {
    const anchor = { key: 'm80', viewportOffset: 12 };
    expect(resolveMobileHistoryAnchorOffset(anchor, {
      positionByKey: () => 11_300,
    })).toBe(11_288);
    expect(resolveMobileHistoryAnchorOffset(anchor, {
      positionByKey: () => 11_348,
    })).toBe(11_336);
  });

  it('uses a nearby captured row if a live render group replaces the primary key', () => {
    expect(resolveMobileHistoryAnchorOffset({
      key: 'live-group-old',
      viewportOffset: -30,
      fallbacks: [{ key: 'm79', viewportOffset: 120 }],
    }, {
      positionByKey: (key) => key === 'm79' ? 11_500 : undefined,
    })).toBe(11_380);
  });

  it('resolves an aggregate row whose outer key changed after same-turn history was prepended', () => {
    const before = buildMobileMessageRenderItems([
      toolUse('tool-b', 2),
      assistantMessage('answer', 3),
    ]);
    const after = buildMobileMessageRenderItems([
      toolUse('tool-a', 1),
      toolUse('tool-b', 2),
      assistantMessage('answer', 3),
    ]);
    const beforeGroup = before[0];
    const afterGroup = after[0];
    expect(beforeGroup.type).toBe('work_group');
    expect(afterGroup.type).toBe('work_group');
    expect(after).toHaveLength(before.length);
    expect(afterGroup.key).not.toBe(beforeGroup.key);

    const identityKey = mobileMessageHistoryAnchorIdentity(beforeGroup);
    expect(identityKey).toBeTruthy();
    expect(mobileMessageHistoryRowKeyByIdentity(after, identityKey!)).toBe(afterGroup.key);
    expect(mobileMessageHistoryOnlyExpandedFirstWorkGroup(before, before)).toBe(false);
    expect(mobileMessageHistoryOnlyExpandedFirstWorkGroup(before, after)).toBe(true);
    expect(mobileMessageHistoryOnlyExpandedFirstWorkGroup(before, buildMobileMessageRenderItems([
      userMessage('earlier-user', 0),
      toolUse('tool-a', 1),
      toolUse('tool-b', 2),
      assistantMessage('answer', 3),
    ]))).toBe(false);
    const anchor = captureMobileHistoryAnchor({
      data: before,
      positionAtIndex: (index) => [0, 180][index],
      scroll: 0,
      start: 0,
      topOffsetAdjustment: 400,
    }, (item) => item.key, mobileMessageHistoryAnchorIdentity);
    expect(anchor?.key).toBe(beforeGroup.key);
    expect(anchor?.viewportOffset).toBe(400);
    expect(resolveMobileHistoryAnchorOffset(anchor!, {
      data: after,
      keyByIdentity: (identity) => mobileMessageHistoryRowKeyByIdentity(after, identity),
      positionByKey: (key) => key === afterGroup.key ? 600 : undefined,
      topOffsetAdjustment: 64,
    })).toBe(264);
  });

  it('falls back to the current data index while LegendList rebuilds its key cache', () => {
    expect(resolveMobileHistoryAnchorOffset({ key: 'm80', viewportOffset: -30 }, {
      data: [{ key: 'older' }, { key: 'm80' }],
      positionAtIndex: (index) => [0, 11_300][index],
      positionByKey: () => undefined,
    })).toBe(11_330);
  });

  it('requires both the scroll offset and target position to be stable', () => {
    expect(isMobileHistoryAnchorSettled(11_330, 11_330, null, 2)).toBe(false);
    expect(isMobileHistoryAnchorSettled(11_330, 11_330, 11_340, 2)).toBe(false);
    expect(isMobileHistoryAnchorSettled(11_329, 11_330, 11_331, 2)).toBe(true);
  });
});

function toolUse(id: string, seconds: number): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'tool_use',
    content: {
      toolUseId: id,
      toolName: 'Read',
      input: { file_path: `/${id}.ts` },
    },
    toolUseId: id,
    agentMeta: null,
    createdAt: `2026-01-01T00:00:0${seconds}.000Z`,
  };
}

function assistantMessage(id: string, seconds: number): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'assistant',
    content: 'done',
    toolUseId: null,
    agentMeta: null,
    createdAt: `2026-01-01T00:00:0${seconds}.000Z`,
  };
}

function userMessage(id: string, seconds: number): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 's1',
    role: 'user',
    content: id,
    toolUseId: null,
    agentMeta: null,
    createdAt: `2026-01-01T00:00:0${seconds}.000Z`,
  };
}
