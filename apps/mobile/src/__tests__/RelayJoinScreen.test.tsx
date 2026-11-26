// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelayJoinError, type RelayAccountOffer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearRelayJoinIntent, receiveRelayJoinIntent, startRelayAccountJoin } from '@/device-link/relayJoinIntent';
import RelayJoinScreen from '../../app/relay-join';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  invite: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
}));

vi.mock('react-native', () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return { View, ScrollView: View, ActivityIndicator: () => null, Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value } };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({ CircleAlert: () => null, CircleCheck: () => null, Server: () => null }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: { children: ReactNode; testID?: string }) => <span data-testid={testID}>{children}</span>,
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; onPress: () => void; busy?: boolean } }) =>
    <button disabled={action.busy} onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({
  SimpleStackHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  simpleScrollInsetProps: {},
  simpleScrollScreenSafeAreaEdges: () => [],
}));

vi.mock('@cindy/device-link', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/device-link')>(),
  fetchRelayInfo: mocks.probe,
  isRelayLinkForOtherAccount: () => false,
  createRelaySigningKey: () => ({ publicKey: 'test-phone-key', seed: new Uint8Array(32) }),
  createRelayJoinIdentity: () => ({ publicKey: 'test-phone-key', seed: new Uint8Array(32), proof: 'test-proof' }),
  submitRelayPairRequest: mocks.submit,
  waitForRelayApproval: mocks.approve,
  acceptRelayDeviceCert: vi.fn(),
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'test-account' }, deviceId: 'test-phone' }),
}));
vi.mock('@/chat/useChatServer', () => ({ useChatClient: () => ({ request: mocks.request }) }));
vi.mock('@/config/env', () => ({ APP_BINARY_VERSION: '1.0.0' }));
vi.mock('@/device-link/relayAccountDirectory', () => ({
  RelayAccountJoinError: class extends Error { constructor(readonly code: string) { super(code); } },
  requestRelayAccountInvite: mocks.invite,
}));
vi.mock('@/device-link/relayAuthCrypto', () => ({ mobileRelayAuthCrypto: {} }));
vi.mock('@/device-link/agentNetPairing', () => ({ prepareMobileAgentNetPairing: async () => undefined }));
vi.mock('@/device-link/agentNetIdentity', () => ({ ensureMobileAgentNetIdentity: vi.fn() }));
vi.mock('@/device-link/selfHostedRelay', () => ({
  createRelayJoinFetch: () => mocks.request,
  saveSelfHostedRelay: mocks.save,
  useSelfHostedRelay: () => null,
}));

const offer: RelayAccountOffer = {
  kind: 'host', relayId: 'test-relay', name: 'Test relay', baseUrl: 'https://relay.example.invalid',
  ownerDeviceId: 'test-mac', ownerDeviceName: 'Test Mac', ownerPublicKey: 'Q'.repeat(43), updatedAt: 0,
};
const link = { baseUrl: offer.baseUrl, ownerPublicKey: offer.ownerPublicKey, code: 'R'.repeat(43), pairSecret: 'S'.repeat(43) };
const info = { relayId: offer.relayId, name: offer.name, protocolVersion: 1, relayVersion: 'test' };

beforeEach(() => {
  vi.resetAllMocks();
  setMobileAuthOwner('test-account');
  mocks.probe.mockResolvedValue(info);
  mocks.invite.mockResolvedValue(link);
  mocks.submit.mockResolvedValue({ requestId: 'test-request', pollToken: 'test-poll', verifyCode: '1234' });
});

afterEach(() => {
  cleanup();
  clearRelayJoinIntent();
  setMobileAuthOwner(null);
});

it('shows the first same-account probe failure, then lets the user retry and join', async () => {
  mocks.probe.mockRejectedValueOnce(new RelayJoinError('UNREACHABLE', 'Synthetic probe failure'));
  let allow: (result: { cert: object; credential: string }) => void = () => {};
  mocks.approve.mockReturnValue(new Promise((resolve) => { allow = resolve; }));

  startRelayAccountJoin(offer);
  render(<RelayJoinScreen />);
  expect(screen.getByText('relay.join.accountRequesting')).toBeDefined();
  await screen.findByText('relay.errors.ownerUnavailable');
  expect(mocks.invite).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'relay.join.retry' }));

  await screen.findByText('relay.join.accountWaiting');
  expect(mocks.invite).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('relayJoin.pairingCode')).toBeNull();
  allow({ cert: {}, credential: 'test-credential' });
  await screen.findByText('relay.join.joinedTitle');
  expect(mocks.save).toHaveBeenCalledTimes(1);
});

it('shows an invalid link without starting a probe', () => {
  expect(receiveRelayJoinIntent('cindy://relay/join')).toBe(true);
  render(<RelayJoinScreen />);
  expect(screen.getByText('relay.join.invalidLink')).toBeDefined();
  expect(mocks.probe).not.toHaveBeenCalled();
});

it('keeps manual confirmation and the pairing code for a QR link', async () => {
  mocks.approve.mockReturnValue(new Promise(() => {}));
  expect(receiveRelayJoinIntent(
    `cindy://relay/join?u=${encodeURIComponent(link.baseUrl)}&c=${link.code}&o=${link.ownerPublicKey}&s=${link.pairSecret}`,
  )).toBe(true);
  render(<RelayJoinScreen />);
  const join = await screen.findByRole('button', { name: 'relay.join.action' });
  expect(mocks.submit).not.toHaveBeenCalled();
  fireEvent.click(join);
  expect((await screen.findByTestId('relayJoin.pairingCode')).textContent).toBe('1234');
  expect(screen.getByText('relay.join.waiting')).toBeDefined();
});
