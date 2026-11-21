import { Keyboard } from 'react-native';
import { getMobileHeights } from './mcpAppMeasuredHeights';
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytes } from 'expo-crypto';
import { confirmsMcpAppViewGone, McpAppController, McpAppHeightGuard, McpAppViewSlots, mcpAppFailureKey, type AppRpc } from '@cindy/maker-shared/mcp-app-controller';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { McpAppSdkCache, MCP_APPS_INVOKE, type McpAppDocument } from '@cindy/maker-shared/mcp-apps';
import { prepareMcpAppNativeDocument, type McpAppNativeDocument } from './mcpAppNativeDocument';

export interface McpAppViewState {
  loading: boolean;
  height: number;
  focus?: { top: number; bottom: number };
  filesUnavailable?: boolean;
  error?: ReturnType<typeof mcpAppFailureKey> | 'mcpApps.mobileUpdateRequired' | 'mcpApps.pluginRevoked';
}
type Invoke = (device: string, channel: string, args: unknown[], options?: { noResultCache?: boolean; preSend?: () => void }) => Promise<unknown>;

const viewSlots = new McpAppViewSlots();
const sdkCache = new McpAppSdkCache(text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text));

export const MCP_APP_DEFAULT_HEIGHT = 320;
/** Owned by the persistent native host, not by a virtualized message/route. */
export class McpAppView {
  readonly id = Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
  readonly bridgeKey = Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
  readonly controller: McpAppController;
  document?: McpAppDocument;
  nativeDocument?: McpAppNativeDocument;
  width = 0;
  state: McpAppViewState;
  closing = false;
  disposed = false;
  inject?: (script: string) => void;
  private listeners = new Set<(state: McpAppViewState) => void>();
  private readonly heightCacheKey: string;
  private readonly heights = getMobileHeights();
  private hasSize = false;
  // The execution Host sends the tool result only once during a View's lifetime.
  private resultDelivered = false;
  private pagePhase: 'static' | 'initializing' | 'ready' = 'static';
  private fallbackTimer?: ReturnType<typeof setTimeout>;
  private pendingMeasurement?: { height: number; width: number; keyboardVisible: boolean };
  private readonly placeholder: number;
  private measuringWithKeyboard = false;
  private readonly heightGuard = new McpAppHeightGuard(() => console.warn('[mcp-apps] App height feedback loop bounded'));
  private closePromise?: Promise<void>;

  constructor(
    invoke: Invoke, deviceId: string, sessionId: string, clientId: string,
    private readonly changed: () => void,
    private readonly removed: () => void,
    openLink: (url: string) => Promise<void>, _ownerGeneration: number, placeholder = MCP_APP_DEFAULT_HEIGHT,
    private readonly isPlugin = false,
    getUserCloseEpoch?: (device: string) => number,
    onUserClose?: (device: string, listener: () => void) => () => void,
  ) {
    this.heightCacheKey = JSON.stringify([deviceId, sessionId, clientId]);
    this.placeholder = placeholder;
    this.state = { loading: true, height: placeholder };
    const sdkOwner = getMobileAuthOwner();
    let linkEpoch: number | undefined;
    const currentLinkEpoch = () => getUserCloseEpoch?.(deviceId);
    const released = () => viewSlots.released(sdkOwner, deviceId, deviceId);
    this.controller = new McpAppController(
      (id, input) => {
        if (input.op === 'open' || input.op === 'open-resource') linkEpoch = currentLinkEpoch();
        const operationLinkEpoch = typeof input.openId === 'string' ? currentLinkEpoch() : undefined;
        const send = (request: Record<string, unknown>) => {
          const preSend = () => {
            if (!isMobileAuthOwnerCurrent(sdkOwner)) throw new Error('MCP_APP_OWNER_CHANGED');
            if (currentLinkEpoch() !== linkEpoch) throw new Error('MCP_APP_LINK_CLOSED');
            if (request.op === 'open' && this.closing) throw new Error('MCP_APP_OPEN_CANCELLED');
          };
          preSend();
          if (request.op === 'open') return invoke(deviceId, MCP_APPS_INVOKE, [id, request], { noResultCache: true, preSend });
          if (request.op === 'poll') return invoke(deviceId, MCP_APPS_INVOKE, [id, request], { noResultCache: true });
          const result = invoke(deviceId, MCP_APPS_INVOKE, [id, request]);
          if (request.op !== 'teardown') return result;
          return result.catch(error => {
            // Also applies to a temporary View retired during an SDK source fallback.
            if (confirmsMcpAppViewGone(error)) released();
            throw error;
          });
        };
        return viewSlots.control(sdkOwner, deviceId, deviceId, input, async allocated => {
          if (input.op === 'open') return sdkCache.open(sdkOwner, deviceId, input, async request => {
            const reply = await send(request);
            if (request.op === 'open') allocated?.();
            return reply;
          }, () => {
            if (!isMobileAuthOwnerCurrent(sdkOwner)) throw new Error('MCP_APP_OWNER_CHANGED');
          }, released);
          const result = await send(input);
          if (input.op === 'teardown') released();
          return result;
        }, operationLinkEpoch,
          onUserClose ? closed => {
            const unwatch = onUserClose(deviceId, closed);
            if (currentLinkEpoch() !== operationLinkEpoch) closed();
            return unwatch;
          } : undefined);
      }, sessionId, clientId,
      (message) => {
        if (this.disposed) return;
        if (!this.closing && hasExecutionComputerFile(message)) {
          this.localFilesUnavailable();
          return;
        }
        if (message.method === 'ui/notifications/tool-result' || message.method === 'ui/notifications/tool-cancelled') {
          this.resultDelivered = true;
          this.scheduleMeasurementFallback();
        }
        const serialized = JSON.stringify(JSON.stringify(message)).replace(/</g, '\\u003c');
        this.inject?.(`window.dispatchEvent(new MessageEvent('message',{data:JSON.parse(${serialized}),source:window}));true;`);
      },
      (message) => {
        if (this.closing) return;
        if (message.method === 'ui/initialize') {
          this.pagePhase = 'initializing';
          this.heightGuard.reset();
          this.pendingMeasurement = undefined;
          clearTimeout(this.fallbackTimer);
          this.fallbackTimer = undefined;
        }
        if (message.method === 'ui/notifications/initialized') {
          this.pagePhase = 'ready';
          this.update({ loading: false });
          this.scheduleMeasurementFallback();
        }
        if (message.method === 'ui/notifications/size-changed' &&
            typeof message.params?.height === 'number' && Number.isFinite(message.params.height) && message.params.height > 0) {
          // After result delivery, retain the previous height throughout a new handshake.
          if (!this.width || (this.pagePhase === 'initializing' && this.resultDelivered)) return;
          const keyboardVisible = Keyboard.isVisible?.() === true;
          if (this.measuringWithKeyboard !== keyboardVisible) {
            this.heightGuard.reset();
            this.measuringWithKeyboard = keyboardVisible;
          }
          const height = this.heightGuard.accept(message.params.height);
          this.pendingMeasurement = { height, width: this.width, keyboardVisible };
          if (this.pagePhase === 'ready' && this.resultDelivered) this.adoptMeasurement();
          else this.scheduleMeasurementFallback();
        }
      },
      (error) => this.fail(error), openLink,
    );
  }

  subscribe(listener: (state: McpAppViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private scheduleMeasurementFallback(): void {
    if (!this.pendingMeasurement || this.fallbackTimer !== undefined || this.pagePhase === 'initializing') return;
    if (this.pagePhase === 'static' || this.resultDelivered)
      this.fallbackTimer = setTimeout(() => this.adoptMeasurement(), 500);
  }
  private adoptMeasurement(): void {
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
    const sample = this.pendingMeasurement;
    this.pendingMeasurement = undefined;
    if (!sample || sample.width !== this.width || this.closing) return;
    this.hasSize = true;
    if (!sample.keyboardVisible && !Keyboard.isVisible?.()) this.heights.remember(this.heightCacheKey, sample.width, sample.height);
    this.update({ height: sample.height });
  }
  setWidth(width: number): void {
    if (Number.isFinite(width) && width > 0 && width !== this.width && !this.disposed) {
      this.width = width;
      this.heightGuard.resize(width);
      if (!this.hasSize) this.update({ height: this.heights.get(this.heightCacheKey, width) ?? this.placeholder });
      else this.changed();
    }
  }
  private update(value: Partial<McpAppViewState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    this.listeners.forEach((listener) => listener(this.state));
    this.changed();
  }
  async open(context: Record<string, unknown>, active = () => true): Promise<void> {
    try {
      const document = await this.controller.open(context, waiting => {
        if (this.closing || !active()) return false;
        this.update({ loading: !waiting, error: waiting ? 'mcpApps.viewLimit' : undefined });
        return true;
      });
      if (!document || this.closing) return;
      if (document.transport === 'sandbox') throw new Error('MCP_APP_INVALID_DOCUMENT');
      const nativeDocument = await prepareMcpAppNativeDocument(document, this.bridgeKey);
      if (this.closing) { await nativeDocument.close(); return; }
      this.document = document;
      this.nativeDocument = nativeDocument;
      this.changed();
    } catch (error) { if (!this.closing) this.fail(error); }
  }
  receive(data: string): void {
    if (this.disposed) return;
    try {
      const envelope = JSON.parse(data) as { key?: string; message: AppRpc };
      if (envelope.key !== this.bridgeKey) return;
      if (envelope.message.method === 'ui/notifications/cindy-mobile-focus') {
        if (this.closing) return;
        const rect = envelope.message.params;
        if (rect === null) this.update({ focus: undefined });
        else if (rect && typeof rect.top === 'number' && typeof rect.bottom === 'number'
          && Number.isFinite(rect.top) && Number.isFinite(rect.bottom)
          && rect.top >= 0 && rect.bottom > rect.top && rect.bottom <= this.state.height + 1)
          this.update({ focus: { top: rect.top, bottom: rect.bottom } });
        return;
      }
      if (envelope.message.method === 'ui/notifications/sandbox-proxy-ready')
        this.controller.sandboxReady(this.nativeDocument?.resourceUrl);
      else this.controller.receive(envelope.message);
    } catch { this.fail(new Error('MCP_APP_INVALID_MESSAGE')); }
  }
  private localFilesUnavailable(): void {
    this.update({ loading: false, error: undefined, filesUnavailable: true });
    void this.close();
  }
  fail(error: unknown): void {
    if (this.closing) return;
    if (/MCP_APP_FILES_LOCAL_ONLY/.test(String(error))) { this.localFilesUnavailable(); return; }
    this.update({ loading: false, error: /MCP_APP_NATIVE_UPDATE_REQUIRED/.test(String(error))
      ? 'mcpApps.mobileUpdateRequired' : this.isPlugin && /MCP_PLUGIN_UNAVAILABLE|MCP_APP_SERVER_CHANGED|MCP_APP_VIEW_UNAVAILABLE/.test(String(error))
        ? 'mcpApps.pluginRevoked' : mcpAppFailureKey(error) });
    void this.close();
  }
  close(): Promise<void> {
    return this.closePromise ??= this.closeView();
  }
  private async closeView(): Promise<void> {
    this.closing = true;
    clearTimeout(this.fallbackTimer);
    // Keep the same root-owned WebView and its callback alive. No RPC/HTTP
    // teardown completion can extend the native disposal deadline indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); });
    this.controller.prepareNativeClose();
    this.changed();
    try {
      await Promise.race([this.controller.close().catch(() => {}), deadline]);
    } finally {
      clearTimeout(timer);
      this.disposed = true;
      this.inject = undefined;
      this.listeners.clear();
      this.removed();
      await this.nativeDocument?.close().catch(() => {});
    }
  }
}

/** Never deliver execution-computer-only file links to a native View that cannot serve them. */
function hasExecutionComputerFile(message: AppRpc): boolean {
  let budget = 50_000;
  const visit = (value: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 24 || !value || typeof value !== 'object') return false;
    const object = value as Record<string, unknown>;
    if (object.type === 'resource_link' && typeof object.uri === 'string'
      && /^(?:cindy-media:|library:|handoff:)/i.test(object.uri)) return true;
    return Object.values(object).some((child) => visit(child, depth + 1));
  };
  return visit(message.params, 0) || visit(message.result, 0);
}
