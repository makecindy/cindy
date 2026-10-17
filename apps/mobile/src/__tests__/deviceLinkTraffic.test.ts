import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDeviceLinkTrafficReport,
  meterDeviceLinkInvokes,
  recordDeviceLinkPush,
  recordDeviceLinkWireFrame,
  resetDeviceLinkTraffic,
  setDeviceLinkTrafficMeterEnabled,
  snapshotDeviceLinkTraffic,
} from '@/debug/deviceLinkTraffic';

afterEach(() => {
  setDeviceLinkTrafficMeterEnabled(false);
  resetDeviceLinkTraffic();
});

describe('dev device-link traffic meter', () => {
  it('stays inert outside dev builds', async () => {
    setDeviceLinkTrafficMeterEnabled(false);
    const client = { invoke: async () => ({ ok: true, result: [1, 2, 3] }) };
    const original = client.invoke;
    meterDeviceLinkInvokes(client);
    expect(client.invoke).toBe(original);
    recordDeviceLinkPush('local-db:sessions:patched', { title: 'x' });
    recordDeviceLinkWireFrame('in', 'frame');
    expect(snapshotDeviceLinkTraffic()).toMatchObject({ channels: {}, wire: { inBytes: 0, inFrames: 0 } });
  });

  it('counts requests, results and pushes per channel without keeping their content', async () => {
    setDeviceLinkTrafficMeterEnabled(true);
    const client = {
      calls: 0,
      async invoke(_dst: string, payload: { channel: string; args?: unknown[] }) {
        this.calls += 1;
        if (payload.channel === 'boom') throw new Error('offline');
        return { ok: true, result: [{ title: '任务' }] };
      },
    };
    meterDeviceLinkInvokes(client);
    await client.invoke('dev', { channel: 'local-db:sessions:list', args: [200] });
    await client.invoke('dev', { channel: 'local-db:sessions:list', args: [200] });
    await expect(client.invoke('dev', { channel: 'boom' })).rejects.toThrow('offline');
    recordDeviceLinkPush('local-db:sessions:patched', { sessionId: 's', patch: { title: '标题' } });
    recordDeviceLinkWireFrame('in', '{"v":1}');
    recordDeviceLinkWireFrame('out', 'é');

    const snapshot = snapshotDeviceLinkTraffic();
    expect(client.calls).toBe(3);
    const list = snapshot.channels['local-db:sessions:list'];
    expect(list.invokes).toBe(2);
    expect(list.requestBytes).toBe(2 * JSON.stringify({ channel: 'local-db:sessions:list', args: [200] }).length);
    // UTF-8 length: "任务" is 6 bytes, not 2 UTF-16 units.
    expect(list.resultBytes).toBe(2 * (JSON.stringify({ ok: true, result: [{ title: '' }] }).length + 6));
    expect(snapshot.channels.boom).toMatchObject({ invokes: 1, resultBytes: 0 });
    expect(snapshot.channels['local-db:sessions:patched']).toMatchObject({ pushes: 1 });
    expect(snapshot.wire).toEqual({ inBytes: 7, inFrames: 1, outBytes: 2, outFrames: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/任务|标题|sessionId|"dev"/);
    expect(formatDeviceLinkTrafficReport(snapshot)).toContain('local-db:sessions:list  invoke×2');

    resetDeviceLinkTraffic();
    expect(snapshotDeviceLinkTraffic().channels).toEqual({});
  });
});
