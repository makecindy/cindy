import { describe, expect, it, vi } from 'vitest';
import {
  buildMobileToolInputDetail,
  fetchMobileToolInputDetail,
  MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES,
  projectLargeSettledToolInputs,
} from '@/session/messageToolPayloadProjection';
import type { RemoteMessage } from '@/session/types';

function message(
  id: string,
  role: RemoteMessage['role'],
  content: unknown,
  toolUseId: string | null,
  patch: Partial<RemoteMessage> = {},
): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: 'session-1',
    role,
    content,
    toolUseId,
    agentMeta: null,
    createdAt: `2026-01-01T00:00:0${id.endsWith('result') ? '2' : '1'}.000Z`,
    ...patch,
  };
}

function toolPair(
  toolName: string,
  input: unknown,
  patch: Partial<RemoteMessage> = {},
): RemoteMessage[] {
  return [
    message('tool-use', 'tool_use', { input, toolName, toolUseId: 'toolu-1' }, 'toolu-1', patch),
    message('tool-result', 'tool_result', 'ok', 'toolu-1'),
  ];
}

describe('projectLargeSettledToolInputs', () => {
  it('projects a persisted ordinary tool only after its exact result arrives', () => {
    const input = { payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1) };
    const projected = projectLargeSettledToolInputs(toolPair('WebFetch', input));

    expect(projected[0]).toMatchObject({
      content: {
        input: null,
        mobilePayloadProjected: true,
        toolName: 'WebFetch',
        toolUseId: 'toolu-1',
      },
      mobileToolInputProjection: {
        projected: true,
        toolName: 'WebFetch',
        toolUseId: 'toolu-1',
        toolUseMessageId: 'tool-use',
        version: 1,
      },
    });
    expect(projected[0].mobileToolInputProjection).not.toHaveProperty('originalBytes');
    expect(projected[1].content).toBe('ok');
  });

  it('keeps small, unsettled, unpersisted, or remotely truncated inputs intact', () => {
    const largeInput = { payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1) };
    const small = toolPair('WebFetch', { payload: 'small' });
    const unsettled = toolPair('WebFetch', largeInput).slice(0, 1);
    const unpersisted = toolPair('WebFetch', largeInput, { id: '' });
    const truncated = toolPair('WebFetch', largeInput, {
      agentMeta: { remoteContentTruncated: true },
    });

    for (const rows of [small, unsettled, unpersisted, truncated]) {
      expect(projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection).toBeUndefined();
    }
  });

  it('requires exact toolUseId pairing instead of adjacent result guessing', () => {
    const rows = toolPair('WebFetch', {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
    });
    rows[1] = { ...rows[1], toolUseId: 'another-tool' };

    expect(projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection).toBeUndefined();
  });

  it.each([
    ['Agent', { prompt: 'x' }],
    ['update_plan', { plan: [{ status: 'in_progress', step: 'x' }] }],
    ['send_to_worker', { message: 'x', target_session_id: 'worker-1' }],
    ['Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }],
  ])('preserves structural %s tool inputs', (toolName, seedInput) => {
    const input = { ...seedInput, padding: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1) };
    expect(projectLargeSettledToolInputs(toolPair(toolName, input))[0].mobileToolInputProjection)
      .toBeUndefined();
  });

  it('counts UTF-8 bytes instead of UTF-16 code units', () => {
    const input = '界'.repeat(Math.ceil(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES / 3) + 1);
    const projected = projectLargeSettledToolInputs(toolPair('WebFetch', input));

    expect(input.length).toBeLessThan(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES);
    expect(projected[0].mobileToolInputProjection).toBeDefined();
  });

  it('includes JSON syntax and escaping while applying the byte threshold', () => {
    const syntaxBytes = '{"payload":""}'.length;
    const exact = { payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES - syntaxBytes) };
    const over = { payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES - syntaxBytes + 1) };

    expect(projectLargeSettledToolInputs(toolPair('WebFetch', exact))[0]
      .mobileToolInputProjection).toBeUndefined();
    expect(projectLargeSettledToolInputs(toolPair('WebFetch', over))[0]
      .mobileToolInputProjection).toBeDefined();
  });

  it('stops inspecting a large input as soon as the threshold is crossed', () => {
    let latePropertyRead = false;
    const input = {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
      get unreadTail() {
        latePropertyRead = true;
        return 'not reached';
      },
    };
    const stringify = vi.spyOn(JSON, 'stringify');

    try {
      expect(projectLargeSettledToolInputs(toolPair('WebFetch', input))[0]
        .mobileToolInputProjection).toBeDefined();
      expect(latePropertyRead).toBe(false);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('is idempotent for an already projected row', () => {
    const first = projectLargeSettledToolInputs(toolPair('WebFetch', {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
    }));
    const second = projectLargeSettledToolInputs(first);

    expect(second[0]).toBe(first[0]);
  });

  it('does not inspect the same settled small input again on later normalizations', () => {
    let inspectionCount = 0;
    const rows = toolPair('WebFetch', {
      get payload() {
        inspectionCount += 1;
        return 'small';
      },
    });

    expect(projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection).toBeUndefined();
    expect(projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection).toBeUndefined();
    expect(inspectionCount).toBe(1);
  });
});

describe('buildMobileToolInputDetail', () => {
  it('restores the full input from the exact authoritative tool row', () => {
    const fullInput = {
      nested: { value: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1) },
    };
    const rows = toolPair('WebFetch', fullInput);
    const projected = projectLargeSettledToolInputs(rows);
    const ref = projected[0].mobileToolInputProjection!;

    const detail = buildMobileToolInputDetail(rows, ref);
    expect(detail?.toolName).toBe('WebFetch');
    expect(detail?.body).toBe(JSON.stringify(fullInput, null, 2));
    expect(detail?.body.length).toBeGreaterThan(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES);
  });

  it('rejects missing, mismatched, truncated, or still-projected rows', () => {
    const original = toolPair('WebFetch', {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
    });
    const projected = projectLargeSettledToolInputs(original);
    const ref = projected[0].mobileToolInputProjection!;

    expect(buildMobileToolInputDetail([], ref)).toBeNull();
    expect(buildMobileToolInputDetail([
      { ...original[0], content: { input: {}, toolName: 'Other', toolUseId: 'toolu-1' } },
    ], ref)).toBeNull();
    expect(buildMobileToolInputDetail([
      { ...original[0], agentMeta: { remoteContentTruncated: true } },
    ], ref)).toBeNull();
    expect(buildMobileToolInputDetail(projected, ref)).toBeNull();
  });
});

describe('fetchMobileToolInputDetail', () => {
  it('requests only the authoritative tool row and returns its full input', async () => {
    const rows = toolPair('WebFetch', {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
    });
    const ref = projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection!;
    const calls: Array<{ messageId: string; radius: number }> = [];

    const detail = await fetchMobileToolInputDetail(ref, async (messageId, options) => {
      calls.push({ messageId, radius: options.radius });
      return rows;
    });

    expect(calls).toEqual([{ messageId: 'tool-use', radius: 0 }]);
    expect(detail.body.length).toBeGreaterThan(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES);
  });

  it('rejects when the authoritative row cannot restore the projected input', async () => {
    const rows = toolPair('WebFetch', {
      payload: 'x'.repeat(MOBILE_TOOL_INPUT_PROJECTION_THRESHOLD_BYTES + 1),
    });
    const ref = projectLargeSettledToolInputs(rows)[0].mobileToolInputProjection!;

    await expect(fetchMobileToolInputDetail(ref, async () => [])).rejects
      .toThrow('tool input is unavailable');
  });
});
