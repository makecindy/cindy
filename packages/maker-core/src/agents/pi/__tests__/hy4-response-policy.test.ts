import { describe, expect, it } from 'vitest';
import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';
import {
  HY4_RESPONSE_POLICY,
  HY4_RESPONSE_POLICY_INSTALL_SOURCE,
} from '../hy4-response-policy.js';

type BeforeStart = (
  event: { systemPrompt: string },
  ctx: { model?: { id?: string } },
) => { systemPrompt: string } | undefined;

describe('HY4 response-channel policy in the Pi bridge', () => {
  it.each(['hy4', 'tencent/hy4', 'tencent/hy4-preview'])(
    'appends instructions without replacing the native prompt for %s', model => {
      let beforeStart: BeforeStart | undefined;
      // Execute exactly the self-contained installer embedded in the child process.
      new Function('pi', HY4_RESPONSE_POLICY_INSTALL_SOURCE)({
        on(name: string, handler: BeforeStart) {
          expect(name).toBe('before_agent_start');
          beforeStart = handler;
        },
      });
      const original = 'Pi native prompt\nUser instructions';
      expect(beforeStart?.({ systemPrompt: original }, { model: { id: model } }))
        .toEqual({ systemPrompt: `${original}\n\n${HY4_RESPONSE_POLICY}` });
      // Switching away must not leave the HY4 override on subsequent turns.
      expect(beforeStart?.({ systemPrompt: original }, { model: { id: 'tencent/hy3' } })).toBeUndefined();
      expect(beforeStart?.({ systemPrompt: original }, { model: { id: 'other/hy4' } })).toBeUndefined();
      expect(beforeStart?.({ systemPrompt: original }, {})).toBeUndefined();
      expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(HY4_RESPONSE_POLICY_INSTALL_SOURCE);
    },
  );
});
