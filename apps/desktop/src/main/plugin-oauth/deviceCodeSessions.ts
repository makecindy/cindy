import {
  oauthId,
  PLUGIN_OAUTH_TTL_MS,
  parseDeviceAuthorizationUrl,
  parseAuthorizationUserCode,
} from '@cindy/device-link';
import type {
  PluginOauthDeviceCodeTarget,
  PluginOauthDeviceCodePrompt,
  PluginOauthDeviceCodeView,
  PluginOauthDeviceCodeRequest,
  PluginOauthDeviceCodeClose,
} from '../../shared/pluginOauthDeviceCode.js';

interface Entry {
  view: PluginOauthDeviceCodeView;
  assertCurrent(): void;
  copy(): void;
  reopen(): Promise<void>;
  close: PluginOauthDeviceCodeClose;
}

const isActive = (
  view: PluginOauthDeviceCodeView,
): view is Extract<PluginOauthDeviceCodeView, { phase: 'ready' | 'browser' }> =>
  view.phase === 'ready' || view.phase === 'browser';

const fail = () => new Error('OAUTH_BRIDGE_UNAVAILABLE');
function parseRequest(raw: unknown): PluginOauthDeviceCodeRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'actionId,deviceId,ghostId,operation,requestId' ||
    !oauthId(v.deviceId) ||
    !oauthId(v.ghostId) ||
    !oauthId(v.requestId) ||
    typeof v.actionId !== 'string' ||
    !v.actionId ||
    v.actionId.length > 256 ||
    [...v.actionId].some((char) => char.charCodeAt(0) < 32) ||
    typeof v.operation !== 'string' ||
    !['read', 'copy', 'reopen'].includes(v.operation)
  )
    throw fail();
  return v as unknown as PluginOauthDeviceCodeRequest;
}

/** Bounded, in-memory display leases belonging to the exact initiating owner and renderer frame. */
export class LocalDeviceCodeSessions {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(scope: string, target: PluginOauthDeviceCodeTarget): string {
    return JSON.stringify([
      scope,
      target.deviceId,
      target.ghostId,
      target.requestId,
      target.actionId,
    ]);
  }

  present(
    scope: string,
    target: PluginOauthDeviceCodeTarget,
    prompt: PluginOauthDeviceCodePrompt,
    deps: {
      assertCurrent(): void;
      copy(code: string): void;
      openExternal(url: string): Promise<void>;
      clearClipboard(): void;
    },
  ): PluginOauthDeviceCodeClose {
    deps.assertCurrent();
    const authorizeUrl = parseDeviceAuthorizationUrl(prompt.authorizeUrl);
    parseAuthorizationUserCode(prompt.userCode);
    if (
      !Number.isSafeInteger(prompt.expiresAt) ||
      prompt.expiresAt <= this.now() ||
      prompt.expiresAt - this.now() > PLUGIN_OAUTH_TTL_MS
    )
      throw fail();
    return this.register(
      scope,
      target,
      {
        phase: 'ready',
        userCode: prompt.userCode,
        verificationHost: new URL(authorizeUrl).hostname,
        expiresAt: prompt.expiresAt,
        copiedAt: this.now(),
      },
      deps.assertCurrent,
      (code) => deps.copy(code),
      () => deps.openExternal(authorizeUrl),
      deps.clearClipboard,
    );
  }

  /** The controller supplies a closure over an already validated URL; no URL reaches Renderer. */
  presentBrowser(
    scope: string,
    target: PluginOauthDeviceCodeTarget,
    expiresAt: number,
    assertCurrent: () => void,
    reopen: () => Promise<void>,
  ): PluginOauthDeviceCodeClose {
    assertCurrent();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt - this.now() > PLUGIN_OAUTH_TTL_MS
    )
      throw fail();
    return this.register(
      scope,
      target,
      { phase: 'browser', expiresAt },
      assertCurrent,
      () => {
        throw fail();
      },
      reopen,
      () => {},
    );
  }

  private register(
    scope: string,
    target: PluginOauthDeviceCodeTarget,
    view: Extract<PluginOauthDeviceCodeView, { phase: 'ready' | 'browser' }>,
    assertCurrent: () => void,
    copy: (code: string) => void,
    reopen: () => Promise<void>,
    clearClipboard: () => void,
  ): PluginOauthDeviceCodeClose {
    const key = this.key(scope, target);
    this.entries.get(key)?.close('ended');
    if (this.entries.size >= 64) {
      for (const [oldKey, entry] of this.entries) {
        if (!isActive(entry.view)) this.entries.delete(oldKey);
      }
      if (this.entries.size >= 64) throw fail();
    }
    const close: PluginOauthDeviceCodeClose = (phase) => {
      if (!isActive(entry.view)) return;
      clearTimeout(expiry);
      clearClipboard();
      // Remove all closures that capture authorization material, retaining only a brief status.
      entry.view = { phase };
      entry.copy = () => {
        throw fail();
      };
      entry.reopen = async () => {
        throw fail();
      };
      const forget = setTimeout(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }, 60_000);
      forget.unref?.();
    };
    const entry: Entry = {
      view,
      assertCurrent,
      reopen,
      close,
      copy: () => {
        if (entry.view.phase !== 'ready') throw fail();
        copy(entry.view.userCode);
        entry.view = { ...entry.view, copiedAt: this.now() };
      },
    };
    this.entries.set(key, entry);
    const expiry = setTimeout(() => close('expired'), view.expiresAt - this.now());
    expiry.unref?.();
    return close;
  }

  async handle(scope: string, raw: unknown): Promise<PluginOauthDeviceCodeView | null> {
    const request = parseRequest(raw);
    const entry = this.entries.get(this.key(scope, request));
    if (!entry) {
      if (request.operation === 'read') return null;
      throw fail();
    }
    try {
      entry.assertCurrent();
    } catch {
      entry.close('ended');
      throw fail();
    }
    if (isActive(entry.view) && this.now() >= entry.view.expiresAt) entry.close('expired');
    if (request.operation !== 'read') {
      if (!isActive(entry.view)) throw fail();
      if (request.operation === 'copy') entry.copy();
      else await entry.reopen();
      try {
        entry.assertCurrent();
      } catch {
        entry.close('ended');
        throw fail();
      }
      if (!isActive(entry.view) || this.now() >= entry.view.expiresAt) {
        entry.close('expired');
        throw fail();
      }
    }
    return { ...entry.view };
  }
}
