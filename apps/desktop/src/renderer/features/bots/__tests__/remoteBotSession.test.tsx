// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseRemoteResourceGetRequest } from '@cindy/device-link';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  pin: vi.fn(),
  merge: vi.fn(),
  view: vi.fn(),
  online: true,
}));
vi.mock('react-router-dom', () => ({ useParams: () => ({ deviceId: 'home', botId: 'writer' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useRemoteBots', () => ({
  useRemoteBots: () => [
    {
      id: 'writer',
      deviceId: 'home',
      deviceName: 'Home',
      name: 'Writer',
      avatar: '',
      avatarColor: '',
      sessionId: 'old-canonical',
      online: h.online,
    },
  ],
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    pinSessionOrigin: h.pin,
    getSessionDeviceId: () => undefined,
    mergeDeviceSessions: h.merge,
  },
}));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: (props: unknown) => {
    h.view(props);
    return <div>remote-conversation</div>;
  },
}));
import { RemoteBotSessionView } from '../RemoteBotSessionView';
beforeEach(() => {
  h.online = true;
  h.pin.mockReset();
  h.merge.mockReset();
  h.view.mockReset();
  h.invoke.mockReset().mockImplementation(async (_device, channel, args) => {
    if (channel === 'maker:remote-resources:get') {
      expect(parseRemoteResourceGetRequest(args[0])).not.toBeNull();
      return {
        ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
        display: { title: 'Writer' },
        links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'new-canonical' } }],
      };
    }
    expect(h.pin).toHaveBeenCalledWith('home', 'new-canonical');
    expect(args).toEqual(['new-canonical']);
    return { id: 'new-canonical', source: 'bot' };
  });
  window.electronAPI = { deviceLink: { invoke: h.invoke } } as unknown as Window['electronAPI'];
});
afterEach(cleanup);
it('resolves the latest canonical task and pins its host before mounting writable chat', async () => {
  const { rerender } = render(<RemoteBotSessionView />);
  await screen.findByText('remote-conversation');
  expect(h.merge).toHaveBeenCalledWith('home', 'Home', [
    expect.objectContaining({ id: 'new-canonical' }),
  ]);
  expect(h.view).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionIdProp: 'new-canonical', routeOwner: true, readOnly: false }),
  );
  h.online = false;
  rerender(<RemoteBotSessionView />);
  await waitFor(() =>
    expect(h.view).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true })),
  );
});
it('never mounts a task with a mismatched authoritative source', async () => {
  h.invoke
    .mockImplementationOnce(async () => ({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
      display: { title: 'Writer' },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'new-canonical' } }],
    }))
    .mockResolvedValueOnce({ id: 'new-canonical', source: 'desktop' });
  await act(async () => {
    render(<RemoteBotSessionView />);
  });
  await screen.findByText('bots.sessionLoadFailedDescription');
  expect(h.view).not.toHaveBeenCalled();
});
