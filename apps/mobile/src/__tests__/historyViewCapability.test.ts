import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1, type LinkAcceptPayload } from '@cindy/device-link';
import { HistoryViewController, isHistoryViewUnavailable, projectHistoryView } from '@cindy/maker-shared/message-window';
import { invokeWithHistoryViewCapability } from '../device-link/historyViewCapability';
import { createMobileMakerTransport, type RemoteInvoke } from '../device-link/mobileMakerTransport';
import type { RemoteMessage } from '../session/types';

const message: RemoteMessage = { id: 'm', clientId: 'm', sessionId: 's', role: 'assistant',
  content: 'saved answer', createdAt: '2026-09-10T00:00:00Z', toolUseId: null, agentMeta: null };
const page = { version: 1 as const, items: projectHistoryView([message], false), hasMore: false, nextCursor: null };
const accepted = (capabilities?: string[]): LinkAcceptPayload => ({ appVersion: 'test', allowlistHash: 'test', capabilities });

describe('history capability negotiation', () => {
  it.each([undefined, [], ['unrelated-capability']])('falls back on old hosts with capabilities %j and still loads older messages', async (capabilities) => {
    const open = vi.fn(async () => accepted(capabilities));
    const wire = vi.fn<RemoteInvoke>(async (_device, channel) => {
      if (channel === 'local-db:messages:list') return [message] as never;
      throw new Error('unsupported channel reached old host');
    });
    const maker = createMobileMakerTransport({ deviceId: 'd',
      invoke: <T,>(device: string, channel: string, args?: unknown[]) =>
        invokeWithHistoryViewCapability(channel, open, () => wire(device, channel, args) as Promise<T>),
    });
    const view = new HistoryViewController<RemoteMessage>({
      page: before => maker.readHistoryView('s', before),
      details: (ref, after) => maker.readWorkDetails('s', ref, after),
      expanded: refs => maker.setHistoryExpanded('s', refs),
    });
    await view.refresh();
    expect(isHistoryViewUnavailable(view.getSnapshot().error)).toBe(true);
    expect(view.getSnapshot()).toMatchObject({ ready: false, loading: false });
    expect(wire).not.toHaveBeenCalled();
    expect(await maker.listMessages('s', { limit: 20 })).toEqual([message]);
    expect(await maker.listMessages('s', { limit: 20, before: 'older' })).toEqual([message]);
    expect(open).toHaveBeenCalledTimes(1);
    await expect(maker.setHistoryExpanded('s', [])).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    view.setNetworkAvailable(false);
    view.setActive(false);
  });

  it.each(['local-db:messages:view', 'local-db:messages:work-details', 'local-db:messages:view-intent'])(
    'waits for the host handshake before sending %s', async (channel) => {
      let resolve!: (value: LinkAcceptPayload) => void;
      const open = vi.fn(() => new Promise<LinkAcceptPayload>(done => { resolve = done; }));
      const wire = vi.fn(async () => page);
      const pending = invokeWithHistoryViewCapability(channel, open, wire);
      expect(wire).not.toHaveBeenCalled();
      resolve(accepted([DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1]));
      expect(await pending).toBe(page);
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it('retires cached projection on downgrade, preserves it on transient failure, and recovers on upgrade', async () => {
    const open = vi.fn(async () => accepted([DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1]));
    const wire = vi.fn(async () => page);
    const view = new HistoryViewController<RemoteMessage>({
      page: () => invokeWithHistoryViewCapability('local-db:messages:view', open, wire),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => {},
    });
    await view.refresh();
    expect(view.getSnapshot().ready).toBe(true);
    const offline = new DeviceLinkError('NOT_CONNECTED', 'offline');
    open.mockRejectedValueOnce(offline);
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({ ready: true, error: offline });
    expect(isHistoryViewUnavailable(view.getSnapshot().error)).toBe(false);
    open.mockResolvedValueOnce(accepted());
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({ ready: false, items: [] });
    expect(isHistoryViewUnavailable(view.getSnapshot().error)).toBe(true);
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({ ready: true, error: null });
    expect(wire).toHaveBeenCalledTimes(2);
    view.setNetworkAvailable(false);
    view.setActive(false);
  });
});
