import type { BrowserWindow, MessageBoxOptions, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { GhostExternalLinkGate, GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS } from '../previewGate';
import { runGhostExternalLinkNavigation } from '../ghostExternalLinkNavigation';

function makeContents() {
  let guestDestroyed = false;
  let hostDestroyed = false;
  let focused = true;
  const host = {
    isDestroyed: vi.fn(() => hostDestroyed),
  } as unknown as WebContents;
  const guest = {
    isDestroyed: vi.fn(() => guestDestroyed),
    isFocused: vi.fn(() => focused),
    hostWebContents: host,
  } as unknown as WebContents;
  return {
    guest,
    host,
    destroyGuest: () => {
      guestDestroyed = true;
    },
    destroyHost: () => {
      hostDestroyed = true;
    },
    detachGuest: () => {
      (guest as unknown as { hostWebContents: WebContents | null }).hostWebContents = null;
    },
    blurGuest: () => {
      focused = false;
    },
  };
}

function makeHarness(options: {
  declared?: string[] | null;
  declaredExternalUrls?: () => string[] | null;
  now?: () => number;
  dialogResponse?: number;
}) {
  const gate = new GhostExternalLinkGate({
    declaredExternalUrls:
      options.declaredExternalUrls ??
      (() => ('declared' in options ? (options.declared ?? null) : [])),
    now: options.now,
  });
  let ownerDestroyed = false;
  const owner = {
    isDestroyed: vi.fn(() => ownerDestroyed),
  } as unknown as BrowserWindow;
  const resolveOwner = vi.fn<(hostContents: WebContents) => BrowserWindow | null>(() => owner);
  const showMessageBox = vi.fn<
    (owner: BrowserWindow, options: MessageBoxOptions) => Promise<{ response: number }>
  >(async () => ({ response: options.dialogResponse ?? 1 }));
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
  const debug = vi.fn();
  const warn = vi.fn();
  let ownerActive = true;
  const translate = vi.fn((key: string) => {
    const labels: Record<string, string> = {
      'ghostPanel.externalLinkConfirm.title': '是否要 Cindy 打开外部网站',
      'ghostPanel.externalLinkConfirm.message': '是否要 Cindy 打开外部网站',
      'ghostPanel.externalLinkConfirm.open': '打开网站',
      'ghostPanel.externalLinkConfirm.cancel': '取消',
    };
    return labels[key] ?? key;
  });
  return {
    gate,
    owner,
    resolveOwner,
    showMessageBox,
    openExternal,
    debug,
    warn,
    translate,
    destroyOwner: () => {
      ownerDestroyed = true;
    },
    setOwnerActive: (active: boolean) => {
      ownerActive = active;
    },
    deps: {
      gate,
      resolveOwner,
      showMessageBox,
      openExternal,
      translate,
      logger: { debug, warn },
      isOwnerActive: () => ownerActive,
    },
  };
}

describe('runGhostExternalLinkNavigation', () => {
  it.each([
    [
      '现有 Manifest 声明',
      'https://example.com/settings/keys',
      ['https://example.com/settings/keys'],
    ],
    ['固定授信主机', 'https://workers.xd.team/workspace/published', []],
  ])('%s 直接调用系统浏览器，不弹确认框', async (_label, url, declared) => {
    const contents = makeContents();
    const harness = makeHarness({ declared });

    await runGhostExternalLinkNavigation(
      { ghostId: 'xd-sites', url, hostContents: contents.host, guestContents: contents.guest },
      harness.deps,
    );

    expect(harness.openExternal).toHaveBeenCalledWith(url);
    expect(harness.showMessageBox).not.toHaveBeenCalled();
    expect(harness.resolveOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['固定授信主机', 'https://workers.xd.team/workspace/published'],
    ['普通 HTTPS', 'https://example.com/workspace'],
  ])('插件已不可用时拒绝%s，不打开也不弹窗', async (_label, url) => {
    const contents = makeContents();
    const harness = makeHarness({ declared: null });

    await runGhostExternalLinkNavigation(
      { ghostId: 'xd-sites', url, hostContents: contents.host, guestContents: contents.guest },
      harness.deps,
    );

    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.showMessageBox).not.toHaveBeenCalled();
    expect(harness.resolveOwner).not.toHaveBeenCalled();
  });

  it('普通 HTTPS 把准确配置挂到发起 webview 的实际宿主窗口', async () => {
    const contents = makeContents();
    const harness = makeHarness({ dialogResponse: 1 });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://EXAMPLE.com:443/a/../workspace',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.resolveOwner).toHaveBeenCalledWith(contents.host);
    expect(harness.showMessageBox).toHaveBeenCalledWith(harness.owner, {
      type: 'question',
      title: '是否要 Cindy 打开外部网站',
      message: '是否要 Cindy 打开外部网站',
      detail: 'https://example.com/workspace',
      buttons: ['打开网站', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    } satisfies MessageBoxOptions);
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('主窗口、侧栏独立窗口与 detached panel 都按各自 hostContents 解析 owner', async () => {
    const surfaces = ['main', 'sidebar', 'detached'] as const;
    const entries = surfaces.map((surface) => {
      const contents = makeContents();
      const owner = {
        surface,
        isDestroyed: vi.fn(() => false),
      } as unknown as BrowserWindow;
      return { surface, contents, owner };
    });
    const ownerByHost = new Map(entries.map(({ contents, owner }) => [contents.host, owner]));
    const gate = new GhostExternalLinkGate({ declaredExternalUrls: () => [] });
    const resolveOwner = vi.fn(
      (hostContents: WebContents) => ownerByHost.get(hostContents) ?? null,
    );
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const openExternal = vi.fn(async () => undefined);
    const deps = {
      gate,
      resolveOwner,
      showMessageBox,
      openExternal,
      translate: (key: string) => key,
      logger: { debug: vi.fn(), warn: vi.fn() },
      isOwnerActive: () => true,
    };

    for (const { surface, contents, owner } of entries) {
      await runGhostExternalLinkNavigation(
        {
          ghostId: `xd-sites-${surface}`,
          url: `https://${surface}.example.com/workspace`,
          hostContents: contents.host,
          guestContents: contents.guest,
        },
        deps,
      );
      expect(resolveOwner).toHaveBeenLastCalledWith(contents.host);
      expect(showMessageBox).toHaveBeenLastCalledWith(owner, expect.any(Object));
    }

    expect(showMessageBox).toHaveBeenCalledTimes(entries.length);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['打开', 0, 1],
    ['取消', 1, 0],
    ['关闭弹窗', -1, 0],
  ])('%s 后只按选择决定是否打开弹窗展示的不可变 URL', async (_label, response, opens) => {
    const contents = makeContents();
    const harness = makeHarness({ dialogResponse: response });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://EXAMPLE.com:443/a/../workspace',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.openExternal).toHaveBeenCalledTimes(opens);
    if (opens === 1)
      expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/workspace');
  });

  it.each(['guest', 'host', 'owner'] as const)('%s 在确认期间销毁后不打开', async (target) => {
    const contents = makeContents();
    const harness = makeHarness({ dialogResponse: 0 });
    harness.showMessageBox.mockImplementationOnce(async () => {
      if (target === 'guest') contents.destroyGuest();
      if (target === 'host') contents.destroyHost();
      if (target === 'owner') harness.destroyOwner();
      return { response: 0 };
    });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/workspace',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('确认期间插件撤权后不打开，并释放确认防重入状态', async () => {
    let now = 1_000;
    let available = true;
    const contents = makeContents();
    const harness = makeHarness({
      now: () => now,
      dialogResponse: 0,
      declaredExternalUrls: () => (available ? [] : null),
    });
    harness.showMessageBox.mockImplementationOnce(async () => {
      available = false;
      return { response: 0 };
    });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/first',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.openExternal).not.toHaveBeenCalled();

    available = true;
    now += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/second',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('owner 在确认期间切换后，即使旧确认返回打开也不执行', async () => {
    const contents = makeContents();
    const harness = makeHarness({});
    let finishDialog!: (value: { response: number }) => void;
    harness.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDialog = resolve;
        }),
    );

    const pending = runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/owner-a-data',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );
    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledOnce());

    harness.setOwnerActive(false);
    finishDialog({ response: 0 });
    await pending;

    expect(harness.openExternal).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it('guest 已脱离原宿主时不弹窗也不打开', async () => {
    const contents = makeContents();
    contents.detachGuest();
    const harness = makeHarness({ dialogResponse: 0 });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/workspace',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('无法解析实际宿主 BrowserWindow 时 fail closed 并释放确认状态', async () => {
    let now = 1_000;
    const contents = makeContents();
    const harness = makeHarness({ now: () => now });
    harness.resolveOwner.mockReturnValue(null);

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/first',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );
    now += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/second',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.resolveOwner).toHaveBeenCalledTimes(2);
    expect(harness.showMessageBox).not.toHaveBeenCalled();
  });

  it('dialog 异常仍释放同一 ghost 的确认防重入状态', async () => {
    let now = 1_000;
    const contents = makeContents();
    const harness = makeHarness({ now: () => now });
    harness.showMessageBox.mockRejectedValueOnce(new Error('dialog failed'));

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/first',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );
    now += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/second',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledWith(
      'ghost external link confirmation failed',
      expect.objectContaining({ ghostId: 'xd-sites', error: 'dialog failed' }),
    );
  });

  it('同一 ghost 确认进行中拒绝重入，不显示第二个 dialog', async () => {
    let now = 1_000;
    const contents = makeContents();
    const harness = makeHarness({ now: () => now });
    let finishDialog!: (value: { response: number }) => void;
    harness.showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDialog = resolve;
        }),
    );

    const first = runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/first',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );
    await vi.waitFor(() => expect(harness.showMessageBox).toHaveBeenCalledOnce());
    now += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/second',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).toHaveBeenCalledOnce();
    finishDialog({ response: 1 });
    await first;
  });

  it('确认框结束后立即释放防重入，不等待 shell.openExternal 完成', async () => {
    let now = 1_000;
    const contents = makeContents();
    const harness = makeHarness({ now: () => now, dialogResponse: 0 });
    let finishOpen!: () => void;
    harness.openExternal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );

    const first = runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/first',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );
    await vi.waitFor(() => expect(harness.openExternal).toHaveBeenCalledOnce());
    now += GHOST_EXTERNAL_LINK_MIN_INTERVAL_MS;
    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/second',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).toHaveBeenCalledTimes(2);
    finishOpen();
    await first;
  });

  it('失焦页面不会直接打开或弹窗', async () => {
    const contents = makeContents();
    contents.blurGuest();
    const harness = makeHarness({ declared: ['https://example.com/settings'] });

    await runGhostExternalLinkNavigation(
      {
        ghostId: 'xd-sites',
        url: 'https://example.com/settings',
        hostContents: contents.host,
        guestContents: contents.guest,
      },
      harness.deps,
    );

    expect(harness.showMessageBox).not.toHaveBeenCalled();
    expect(harness.openExternal).not.toHaveBeenCalled();
  });

  it('shell.openExternal 失败只记录 warn，不向调用方抛错', async () => {
    const contents = makeContents();
    const harness = makeHarness({});
    harness.openExternal.mockRejectedValueOnce(new Error('shell failed'));

    await expect(
      runGhostExternalLinkNavigation(
        {
          ghostId: 'xd-sites',
          url: 'https://workers.xd.team/workspace/published',
          hostContents: contents.host,
          guestContents: contents.guest,
        },
        harness.deps,
      ),
    ).resolves.toBeUndefined();
    expect(harness.warn).toHaveBeenCalledWith(
      'ghost external link open failed',
      expect.objectContaining({ ghostId: 'xd-sites', error: 'shell failed' }),
    );
  });
});
