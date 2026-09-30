// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialProvider } from '@cindy/auth-client';

const native = vi.hoisted(() => ({
  platform: 'ios',
  listeners: new Set<(state: string) => void>(),
  available: vi.fn(),
  supported: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (
      _event: string,
      listener: (state: string) => void,
    ) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));

vi.mock('@/auth/nativeSocial', () => ({
  isNativeSocialProviderAvailable: native.available,
  isNativeSocialProviderSupported: native.supported,
}));

import { useMobileSocialProviderModes } from '../useMobileSocialProviderModes';

const providers: SocialProvider[] = ['wechat'];

function Probe({
  wechatLoginEnabled,
  region = 'cn',
}: {
  wechatLoginEnabled?: boolean;
  region?: 'cn' | 'global';
}) {
  const modes = useMobileSocialProviderModes({
    providers,
    region,
    wechatLoginEnabled,
  });
  return (
    <div>
      {[...modes.keys()].map((provider) => (
        <button data-testid={`login.${provider}Button`} key={provider} />
      ))}
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;

async function renderProbe(
  wechatLoginEnabled?: boolean,
  region: 'cn' | 'global' = 'cn',
) {
  await act(async () => {
    root.render(<Probe wechatLoginEnabled={wechatLoginEnabled} region={region} />);
    await Promise.resolve();
  });
}

function wechatButton() {
  return host.querySelector('[data-testid="login.wechatButton"]');
}

describe('mobile social provider visibility', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    native.platform = 'ios';
    native.available.mockReset().mockResolvedValue(false);
    native.supported.mockReset().mockReturnValue(true);
    host = document.createElement('div');
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    expect(native.listeners.size).toBe(0);
  });

  it('shows WeChat on iOS after the first successful installation probe', async () => {
    native.available.mockResolvedValue(true);
    await renderProbe();
    expect(wechatButton()).not.toBeNull();
    expect(native.available).toHaveBeenCalledWith('wechat');
  });

  it('hides WeChat on Android even when configured and installed', async () => {
    native.platform = 'android';
    native.available.mockResolvedValue(true);
    await renderProbe();
    expect(wechatButton()).toBeNull();
    expect(native.available).not.toHaveBeenCalled();
  });

  it('hides WeChat on Global iOS without probing installation', async () => {
    native.available.mockResolvedValue(true);
    await renderProbe(undefined, 'global');
    expect(wechatButton()).toBeNull();
    expect(native.available).not.toHaveBeenCalled();
  });

  it('keeps WeChat hidden on iOS when the installation probe fails', async () => {
    await renderProbe();
    expect(wechatButton()).toBeNull();
  });

  it('refreshes iOS WeChat visibility on foreground', async () => {
    native.available.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await renderProbe();
    expect(wechatButton()).toBeNull();

    await act(async () => {
      for (const listener of native.listeners) listener('active');
      await Promise.resolve();
    });

    expect(wechatButton()).not.toBeNull();
    expect(native.available).toHaveBeenCalledTimes(2);
  });

  it('hides iOS WeChat after it is uninstalled while Cindy is in the background', async () => {
    native.available.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await renderProbe();
    expect(wechatButton()).not.toBeNull();

    await act(async () => {
      for (const listener of native.listeners) listener('active');
      await Promise.resolve();
    });

    expect(wechatButton()).toBeNull();
  });

  it('ignores an older installation probe that completes after a foreground refresh', async () => {
    let finishFirstProbe!: (installed: boolean) => void;
    native.available
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
        finishFirstProbe = resolve;
      }))
      .mockResolvedValueOnce(false);
    await renderProbe();

    await act(async () => {
      for (const listener of native.listeners) listener('active');
      await Promise.resolve();
    });
    await act(async () => {
      finishFirstProbe(true);
      await Promise.resolve();
    });

    expect(wechatButton()).toBeNull();
    expect(native.available).toHaveBeenCalledTimes(2);
  });

  it('does not probe or show WeChat when explicitly disabled', async () => {
    native.available.mockResolvedValue(true);
    await renderProbe(false);
    expect(wechatButton()).toBeNull();
    expect(native.available).not.toHaveBeenCalled();
    expect(native.listeners.size).toBe(0);
  });
});
