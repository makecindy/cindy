// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudInstanceLoginView } from '../../../../shared/cloudInstanceLogin';
import type { DesktopLoginAction } from '../../../../shared/authIpc';
import type { CloudLoginWindowState } from '../../../../shared/cloudLoginWindow';

// Unit: the auxiliary login must use only cloud handles, preserve SSO, and
// dispose late results. The shared local login tests cannot cover this scope.
const translate = (key: string) => key;
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: translate }),
}));
vi.mock('@/components/login/LoginBrandStage', () => ({ LoginBrandStage: () => null }));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut: () => {} }));
vi.mock('@/components/login/LoginPage', () => ({
  LoginPageView: ({
    onClose,
    login,
    targetLabel,
  }: {
    onClose: () => void;
    targetLabel: string;
    login: {
      dispatch: (a: DesktopLoginAction) => Promise<boolean>;
      loginState: { step: string } | null;
    };
  }) => (
    <>
      <output>
        {targetLabel}:{login.loginState?.step}
      </output>
      <button onClick={() => void login.dispatch({ type: 'discover-sso-org', org: 'example' })}>
        SSO
      </button>
      <button onClick={onClose}>close</button>
    </>
  ),
}));
import { CloudInstanceLoginFlow } from '../CloudInstanceLoginPage';
import { CloudLoginWindowLayout } from '../CloudLoginWindowRoot';
const view: CloudInstanceLoginView = {
  handle: '11111111-1111-4111-8111-111111111111',
  complete: false,
  state: {
    step: 'identifier',
    providers: {
      region: 'cn',
      attribution: 'phone',
      phone: true,
      email: false,
      social: ['wechat', 'apple'],
    },
  },
};
const api = {
  instanceList: vi.fn(async () => [
    { deviceId: 'cloud-device-test', loginRequired: true, name: 'Cloud Test' },
  ]),
  instanceLoginStart: vi.fn(async () => structuredClone(view)),
  instanceLoginDispatch: vi.fn(async () => structuredClone(view)),
  instanceLoginPoll: vi.fn(async () => structuredClone(view)),
  instanceLoginClose: vi.fn(async () => undefined),
};
const target = { deviceId: 'cloud-device-test', name: 'Cloud Test', ordinal: null };
function mount() {
  const close = vi.fn();
  return { ...render(<CloudInstanceLoginFlow target={target} api={api} onClose={close} />), close };
}
beforeEach(() => {
  vi.clearAllMocks();
  api.instanceLoginStart.mockResolvedValue(structuredClone(view));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      cloudSettings: api,
      authInitialize: vi.fn(() => {
        throw Error('local login forbidden');
      }),
    },
  });
});
afterEach(cleanup);
it('routes SSO only to the cloud handle and cancels on exit', async () => {
  const mounted = mount();
  await screen.findByText('Cloud Test:identifier');
  fireEvent.click(screen.getByText('SSO'));
  await waitFor(() =>
    expect(api.instanceLoginDispatch).toHaveBeenCalledWith({
      handle: view.handle,
      action: { type: 'discover-sso-org', org: 'example' },
    }),
  );
  fireEvent.click(screen.getByText('close'));
  expect(mounted.close).toHaveBeenCalledOnce();
  mounted.unmount();
  expect(api.instanceLoginClose).toHaveBeenCalledWith({ handle: view.handle });
  expect(window.electronAPI.authInitialize).not.toHaveBeenCalled();
});
it('closes a handle that arrives after leaving the route', async () => {
  let resolve!: (v: CloudInstanceLoginView) => void;
  api.instanceLoginStart.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const mounted = mount();
  await waitFor(() => expect(api.instanceLoginStart).toHaveBeenCalledOnce());
  mounted.unmount();
  await act(async () => resolve(view));
  expect(api.instanceLoginClose).toHaveBeenCalledExactlyOnceWith({ handle: view.handle });
});
it('starts a clean flow after close/reopen instead of reusing the previous form', async () => {
  const mounted = mount();
  await screen.findByText('Cloud Test:identifier');
  mounted.unmount();
  mount();
  await waitFor(() => expect(api.instanceLoginStart).toHaveBeenCalledTimes(2));
  expect(api.instanceLoginClose).toHaveBeenCalledWith({ handle: view.handle });
});

// Unit / cross-target UI isolation: previous tests unmount without a replacement.
// An old dispatch and an out-of-order state broadcast must not overwrite B's form.
it('keeps B’s form when A’s dispatch and state broadcast arrive after switching', async () => {
  let changed!: (state: CloudLoginWindowState) => void;
  let resolveA!: (state: CloudInstanceLoginView) => void;
  const stateA = { generation: 1, target };
  const stateB = {
    generation: 2,
    target: { deviceId: 'cloud-device-b', name: 'Cloud B', ordinal: 2 },
  };
  const viewB = { ...structuredClone(view), handle: '22222222-2222-4222-8222-222222222222' };
  const bridge = {
    getState: vi.fn(async () => stateA),
    onChanged: (cb: typeof changed) => {
      changed = cb;
      return () => {};
    },
    onLocaleChanged: () => () => {},
    rendererReady: vi.fn(async () => stateA),
    presentationReady: vi.fn(async () => stateA),
    start: vi.fn(async (generation: number) => structuredClone(generation === 1 ? view : viewB)),
    dispatch: vi.fn(
      () =>
        new Promise<CloudInstanceLoginView>((r) => {
          resolveA = r;
        }),
    ),
    poll: vi.fn(async (generation: number) => structuredClone(generation === 1 ? view : viewB)),
    end: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  Object.assign(window.electronAPI, { cloudLoginWindow: bridge });
  const mounted = render(<CloudLoginWindowLayout />);
  await screen.findByText('Cloud Test:identifier');
  fireEvent.click(screen.getByText('SSO'));
  expect(bridge.dispatch).toHaveBeenCalledWith(1, {
    handle: view.handle,
    action: { type: 'discover-sso-org', org: 'example' },
  });
  act(() => changed(stateB));
  await screen.findByText('Cloud B:identifier');
  expect(bridge.end).toHaveBeenCalledWith(1, { handle: view.handle });
  await act(async () => {
    resolveA({ ...view, state: { step: 'browser-redirect', label: 'A only' } });
    changed(stateA);
  });
  expect(screen.getByText('Cloud B:identifier')).toBeTruthy();
  expect(screen.queryByText(/browser-redirect/)).toBeNull();
  expect(bridge.start).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText('close'));
  expect(bridge.close).toHaveBeenCalledExactlyOnceWith(2);
  mounted.unmount();
  expect(bridge.end).toHaveBeenLastCalledWith(2, { handle: viewB.handle });
});
