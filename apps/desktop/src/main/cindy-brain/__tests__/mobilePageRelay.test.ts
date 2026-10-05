import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { mobilePageRelayScript } from '../runtime/mobilePageRelay.js';

describe('mobile page relay', () => {
  it('preserves page context, acknowledges by cursor and closes one page without affecting another', () => {
    const channels: Array<{
      name: string;
      onmessage?: (e: { data: unknown }) => void;
      sent: unknown[];
      closed: boolean;
    }> = [];
    class Channel {
      sent: unknown[] = [];
      closed = false;
      constructor(public name: string) {
        channels.push(this);
      }
      postMessage(data: unknown) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
      }
    }
    const context = { BroadcastChannel: Channel, TextEncoder };
    const run = (op: Parameters<typeof mobilePageRelayScript>[0]) =>
      runInNewContext(mobilePageRelayScript(op), context);
    run({ op: 'connect', pageId: 'a', channels: ['practice'] });
    run({ op: 'connect', pageId: 'b', channels: ['practice'] });
    run({
      op: 'post',
      pageId: 'a',
      channel: 'practice',
      data: { op: 'delete', mobilePageId: 'forged' },
    });
    expect(channels[0].sent).toEqual([{ op: 'delete', mobilePageId: 'a' }]);
    channels[0].onmessage?.({ data: { saved: true } });
    expect(run({ op: 'poll', pageId: 'a', after: 0 })).toHaveLength(1);
    expect(run({ op: 'poll', pageId: 'a', after: 0 })).toHaveLength(1);
    expect(run({ op: 'poll', pageId: 'a', after: 1 })).toHaveLength(0);
    run({ op: 'disconnect', pageId: 'a' });
    expect(channels[0].closed).toBe(true);
    expect(channels[1].closed).toBe(false);
  });
});
