// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { Text } from '@/components/AppText';
import { MailLinkSpan } from '@/session/MailLinkSpan';
import { ChatFilePathContext, MarkdownLinkActivationContext, useMarkdownLinkActivation } from '@/session/chatFilePathContext';

const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn(), open: vi.fn(), invoke: vi.fn() }));
vi.mock('react-native', () => ({ Linking: { openURL: mocks.open } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, onPress }: { children: string; onPress: () => void }) =>
  createElement('button', { onClick: onPress }, children),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: mocks.invoke }) }));
vi.mock('@/device-link/remoteResources', () => ({ getRemoteResource: mocks.get }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const url = 'https://mail.example.test/message';
const task = { deviceId: 'device', sessionId: 'task', workdir: '/repo',
  statPath: vi.fn(), onOpenPath: vi.fn() };

function Message({ revision, carrier }: { revision: string; carrier: string }) {
  const activation = useMarkdownLinkActivation(true, revision);
  return <MarkdownLinkActivationContext.Provider value={activation}>
    <MailLinkSpan key={carrier} url={url} SpanText={Text} style={undefined}>{carrier}</MailLinkSpan>
  </MarkdownLinkActivationContext.Provider>;
}

// #11474: one delayed HTTPS recognition result used to disappear when the
// native span unmounted at table promotion. Unit, controlled in-memory result;
// table document tests alone use a stub opener and cannot cover this boundary.
it.each(['carrier change', 'content revision', 'account change'] as const)(
  'checks delayed mail recognition after a %s', async change => {
    vi.clearAllMocks();
    setMobileAuthOwner('owner');
    let complete!: (value: { blocks: { data: { supported: boolean } }[] }) => void;
    mocks.get.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (revision: string, carrier: string) => act(() => root.render(
      <ChatFilePathContext.Provider value={task}><Message revision={revision} carrier={carrier} /></ChatFilePathContext.Provider>,
    ));
    try {
      render('first', 'native');
      act(() => host.querySelector('button')!.click());
      expect(mocks.get).toHaveBeenCalledTimes(1);
      if (change === 'account change') setMobileAuthOwner('other-owner');
      render(change === 'content revision' ? 'next' : 'first', 'document');
      if (change === 'carrier change') {
        act(() => host.querySelector('button')!.click());
        expect(mocks.get).toHaveBeenCalledTimes(1);
      }
      await act(async () => complete({ blocks: [{ data: { supported: true } }] }));
      if (change === 'carrier change') {
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
          pathname: '/mail-preview', params: { deviceId: 'device', sessionId: 'task', url },
        });
      } else expect(mocks.push).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      setMobileAuthOwner(null);
    }
  },
);
