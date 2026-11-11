import { getRandomBytes } from 'expo-crypto';
import { McpAppController, McpAppHeightGuard, mcpAppFailureKey, type AppRpc } from '@cindy/maker-shared/mcp-app-controller';
import { MCP_APPS_INVOKE, type McpAppDocument } from '@cindy/maker-shared/mcp-apps';
import { prepareMcpAppNativeDocument, type McpAppNativeDocument } from './mcpAppNativeDocument';

export interface McpAppViewState {
  loading: boolean;
  height: number;
  filesUnavailable?: boolean;
  error?: ReturnType<typeof mcpAppFailureKey> | 'mcpApps.mobileUpdateRequired';
}
type Invoke = (device: string, channel: string, args: unknown[]) => Promise<unknown>;

/** Owned by the persistent native host, not by a virtualized message/route. */
export class McpAppView {
  readonly id = Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
  readonly bridgeKey = Array.from(getRandomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
  readonly controller: McpAppController;
  document?: McpAppDocument;
  nativeDocument?: McpAppNativeDocument;
  width = 1;
  state: McpAppViewState = { loading: true, height: 320 };
  closing = false;
  disposed = false;
  inject?: (script: string) => void;
  private listeners = new Set<(state: McpAppViewState) => void>();
  private readonly heightGuard = new McpAppHeightGuard(() => console.warn('[mcp-apps] App height feedback loop bounded'));
  private closePromise?: Promise<void>;

  constructor(
    invoke: Invoke, deviceId: string, sessionId: string, clientId: string,
    private readonly changed: () => void,
    private readonly removed: () => void,
    openLink: (url: string) => Promise<void>,
  ) {
    this.controller = new McpAppController(
      (id, input) => invoke(deviceId, MCP_APPS_INVOKE, [id, input]), sessionId, clientId,
      (message) => {
        if (this.disposed) return;
        if (!this.closing && hasExecutionComputerFile(message)) {
          this.localFilesUnavailable();
          return;
        }
        const serialized = JSON.stringify(JSON.stringify(message)).replace(/</g, '\\u003c');
        this.inject?.(`window.dispatchEvent(new MessageEvent('message',{data:JSON.parse(${serialized}),source:window}));true;`);
      },
      (message) => {
        if (this.closing) return;
        if (message.method === 'ui/notifications/initialized') this.update({ loading: false });
        if (message.method === 'ui/notifications/size-changed' &&
            typeof message.params?.height === 'number' && Number.isFinite(message.params.height))
          this.update({ height: this.heightGuard.accept(message.params.height) });
      },
      (error) => this.fail(error), openLink,
    );
  }

  subscribe(listener: (state: McpAppViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  setWidth(width: number): void {
    if (Number.isFinite(width) && width > 0 && width !== this.width && !this.disposed) {
      this.width = width;
      this.heightGuard.resize(width);
      this.changed();
    }
  }
  private update(value: Partial<McpAppViewState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    this.listeners.forEach((listener) => listener(this.state));
    this.changed();
  }
  async open(context: Record<string, unknown>): Promise<void> {
    try {
      const document = await this.controller.open(context);
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
      ? 'mcpApps.mobileUpdateRequired' : mcpAppFailureKey(error) });
    void this.close();
  }
  close(): Promise<void> {
    return this.closePromise ??= this.closeView();
  }
  private async closeView(): Promise<void> {
    this.closing = true;
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
