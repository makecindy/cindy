import { AcpClient, AcpError, record, type AcpRecord, type AcpResponse, type AcpTransport } from './client.js';
import type { Effort } from '../../types/common.js';
import { isAntigravitySubscriptionModel } from './model-policy.js';
export interface AcpSubscriptionOptions {
  transport: AcpTransport;
  cwd: string;
  assertSubscriptionOnly(): Promise<void>;
  systemPrompt?: string;
  onUpdate(update: AcpRecord): void;
  onClose?(): void;
  requestPermission(input: AcpRecord, signal: AbortSignal): Promise<boolean>;
}
export interface AcpDiscoveredModel {
  id: string; name: string;
  efforts?: Effort[];
  defaultEffort?: Effort | null;
  effortDisplayNames?: Partial<Record<Effort, string>>;
}
// These are wire values, admitted only when the native picker/variant list offers them.
const effortIds: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function selectValues(option: AcpRecord | undefined): AcpRecord[] {
  if (!option || !Array.isArray(option.options)) return [];
  return option.options.map(record).flatMap(item => Array.isArray(item.options) ? item.options.map(record) : [item]);
}
/** Native Antigravity agent over ACP, never a proxy for model HTTP. */
export class AcpSubscriptionSession {
  private client: AcpClient;
  private authenticated = false;
  private sessionId: string | undefined;
  private capabilities: AcpRecord = {};
  private busy = false;
  private ready = false;
  private cancelEpoch = 0;
  private permissions = new Set<AbortController>();
  private legacyModels: AcpRecord[] = [];
  private nativeDefaults = new Map<string, Effort>();
  private pendingUpdates: Array<{ sessionId: unknown; update: AcpRecord }> = [];
  tier: { id: string; name: string } | undefined;
  private readTier(reply: AcpRecord): void {
    const tier = record(record(record(reply._meta).antigravity).tier);
    if (typeof tier.id === 'string' && typeof tier.name === 'string') this.tier = { id: tier.id, name: tier.name };
  }
  models: AcpDiscoveredModel[] = [];
  configOptions: AcpRecord[] = [];
  currentModel: string | undefined;
  currentMode: string | undefined;
  constructor(private options: AcpSubscriptionOptions) {
    this.client = new AcpClient(options.transport, () => queueMicrotask(() => {
      this.ready = false; this.authenticated = false;
      for (const permission of this.permissions) permission.abort();
      options.onClose?.();
    }));
    this.client.onNotification = (method, params) => {
      if (method !== 'session/update') return;
      const update = record(params.update);
      if (!this.ready) {
        // new/load may publish control state before their response. Preserve it,
        // but never replay historical text/tool events as a new Cindy turn.
        if (['usage_update', 'config_option_update', 'current_mode_update'].includes(String(update.sessionUpdate))) {
          this.pendingUpdates.push({ sessionId: params.sessionId, update });
          if (this.pendingUpdates.length > 64) this.pendingUpdates.shift();
        }
      } else if (params.sessionId === this.sessionId) this.receiveUpdate(update);
    };
    this.client.onRequest = async (method, params, signal) => {
      if (method !== 'session/request_permission' || params.sessionId !== this.sessionId) throw new AcpError(-32601);
      // Never persist allow-always grants in the account's upstream config.
      const offered = Array.isArray(params.options) ? params.options.map(record) : [];
      const allow = offered.find(option => option.kind === 'allow_once' && typeof option.optionId === 'string');
      const reject = offered.find(option => option.kind === 'reject_once' && typeof option.optionId === 'string');
      if (!allow || !reject || signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const controller = new AbortController(); this.permissions.add(controller);
      const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
      try {
        const allowed = await Promise.race([
          options.requestPermission(record(params.toolCall), controller.signal),
          new Promise<boolean>(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true })),
        ]);
        return controller.signal.aborted ? { outcome: { outcome: 'cancelled' } } :
          { outcome: { outcome: 'selected', optionId: (allowed ? allow : reject).optionId } };
      } finally { this.permissions.delete(controller); signal.removeEventListener('abort', abort); }
    };
  }
  private receiveUpdate(update: AcpRecord): void {
    if (update.sessionUpdate === 'config_option_update') this.applyConfigOptions(update);
    if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') this.currentMode = update.currentModeId;
    this.options.onUpdate(update);
  }
  private applyConfigOptions(reply: AcpRecord): void {
    if (!Array.isArray(reply.configOptions)) return;
    this.configOptions = reply.configOptions.map(record);
    const picker = this.configOptions.find(option => option.category === 'model');
    if (typeof picker?.currentValue === 'string') this.currentModel = picker.currentValue;
    const thought = this.configOptions.find(option => option.category === 'thought_level');
    const mode = this.configOptions.find(option => option.category === 'mode');
    if (typeof mode?.currentValue === 'string') this.currentMode = mode.currentValue;
    if (this.currentModel && effortIds.includes(thought?.currentValue as Effort) && !this.nativeDefaults.has(this.currentModel)) {
      this.nativeDefaults.set(this.currentModel, thought!.currentValue as Effort);
    }
    if (!picker) return;
    const discovered = selectValues(picker).filter(m => typeof m.value === 'string' && typeof m.name === 'string').map(m => {
      const id = m.value as string;
      const offered = id === this.currentModel ? selectValues(thought) : [];
      // The compatibility model list contains the server's real effort variants.
      // Never infer tiers from model families or offer every global effort id.
      const variants = effortIds.filter(effort => this.legacyModels.some(variant => variant.modelId === `${id}-${effort}`));
      const efforts = id === this.currentModel ? effortIds.filter(effort => offered.some(value => value.value === effort)) : variants;
      const labels = Object.fromEntries(offered.filter(v => effortIds.includes(v.value as Effort) && typeof v.name === 'string').map(v => [v.value, v.name]));
      return { id, name: m.name as string, efforts, defaultEffort: this.nativeDefaults.get(id) ?? null,
        ...(Object.keys(labels).length ? { effortDisplayNames: labels } : {}) };
    });
    if (discovered.length > 0 || this.models.length === 0) {
      this.models = discovered;
    }
  }
  get currentEffort(): Effort | undefined {
    const value = this.configOptions.find(option => option.category === 'thought_level')?.currentValue;
    return effortIds.includes(value as Effort) ? value as Effort : undefined;
  }
  get supportsImageInput(): boolean {
    return record(this.capabilities.promptCapabilities).image === true;
  }
  async initialize(): Promise<void> {
    const reply = await this.client.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'cindy', title: 'Cindy', version: '0.1.136' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (reply.protocolVersion !== 1 || record(reply.agentInfo).name !== 'Antigravity ACP Server') throw new AcpError(-32600);
    this.capabilities = record(reply.agentCapabilities);
    const methods = Array.isArray(reply.authMethods) ? reply.authMethods.map(record) : [];
    if (!methods.some(method => method.id === 'oauth-personal')) throw new AcpError(-32601);
  }
  async authenticate(): Promise<void> {
    await this.options.assertSubscriptionOnly(); this.authenticated = false; this.tier = undefined;
    const reply = await this.client.request('authenticate', { methodId: 'oauth-personal' }, 330_000);
    this.readTier(reply);
    this.authenticated = true;
  }
  async open(input: { resumeId?: string; mcpServers?: AcpRecord[]; mode?: string; cachedAuthentication?: boolean } = {}): Promise<string> {
    if ((!this.authenticated && !input.cachedAuthentication) || this.sessionId) throw new AcpError(-32000);
    await this.options.assertSubscriptionOnly();
    const params: AcpRecord = { cwd: this.options.cwd, mcpServers: input.mcpServers ?? [] };
    if (this.options.systemPrompt) {
      if (record(record(record(this.capabilities._meta).antigravity).systemPrompt).append !== true) throw new AcpError(-32601);
      params._meta = { antigravity: { systemPrompt: { append: this.options.systemPrompt } } };
    }
    let reply: AcpRecord;
    if (input.resumeId) {
      if (this.capabilities.loadSession !== true) throw new AcpError(-32601);
      this.sessionId = input.resumeId;
      try { reply = await this.client.request(record(this.capabilities.sessionCapabilities).resume ? 'session/resume' : 'session/load', { ...params, sessionId: input.resumeId }); }
      catch (error) { this.sessionId = undefined; throw error; }
    } else {
      reply = await this.client.request('session/new', params);
      if (typeof reply.sessionId !== 'string' || !reply.sessionId || reply.sessionId.length > 4096 || /[\r\n\0]/.test(reply.sessionId)) throw new AcpError(-32600);
      this.sessionId = reply.sessionId;
    }
    this.readTier(reply);
    // session/new itself enforces the server's cached credentials. This path is
    // discovery only and never invokes authenticate or starts an OAuth browser flow.
    if (input.cachedAuthentication) this.authenticated = true;
    const legacy = record(reply.models);
    this.legacyModels = (Array.isArray(legacy.availableModels) ? legacy.availableModels : []).map(record);
    this.currentModel = typeof legacy.currentModelId === 'string' ? legacy.currentModelId : undefined;
    this.models = this.legacyModels
      .filter(m => typeof m.modelId === 'string' && typeof m.name === 'string').map(m => ({ id: m.modelId as string, name: m.name as string }));
    this.applyConfigOptions(reply);
    const modeReply = await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId: input.mode ?? 'default' });
    this.applyConfigOptions(modeReply);
    this.currentMode = input.mode ?? 'default';
    this.ready = true;
    for (const pending of this.pendingUpdates.splice(0)) if (pending.sessionId === this.sessionId) this.receiveUpdate(pending.update);
    return this.sessionId;
  }
  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId || !this.ready || this.busy) throw new AcpError(-32000);
    const mode = this.configOptions.find(option => option.category === 'mode');
    if (mode && !selectValues(mode).some(value => value.value === modeId)) throw new AcpError(-32602);
    const reply = await this.client.request('session/set_mode', { sessionId: this.sessionId, modeId });
    this.applyConfigOptions(reply);
    this.currentMode = modeId;
  }
  async setModel(modelId: string): Promise<void> {
    if (!this.sessionId || this.busy || !this.models.some(m => m.id === modelId)) throw new AcpError(-32602);
    const picker = this.configOptions.find(option => option.category === 'model');
    if (picker && typeof picker.id === 'string') {
      const reply = await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: picker.id, value: modelId });
      this.applyConfigOptions(reply);
      if (this.currentModel !== modelId) throw new AcpError(-32600);
    }
    else await this.client.request('session/set_model', { sessionId: this.sessionId, modelId });
    this.currentModel = modelId;
  }
  async setEffort(effort: Effort): Promise<void> {
    const picker = this.configOptions.find(option => option.category === 'thought_level');
    if (!this.sessionId || !this.ready || this.busy || typeof picker?.id !== 'string' || !selectValues(picker).some(value => value.value === effort)) throw new AcpError(-32602);
    const reply = await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: picker.id, value: effort });
    this.applyConfigOptions(reply);
    if (this.currentEffort !== effort) throw new AcpError(-32600);
  }
  /** Read each admitted model picker's actual default from the same native baseline.
   * Model/effort changes are control operations, never prompts; restore the
   * account's original selection even if a discovery operation fails. */
  async discoverModelOptions(): Promise<void> {
    const model = this.currentModel; const effort = this.currentEffort;
    if (!model || !this.configOptions.some(option => option.category === 'model')) return;
    const restore = async () => {
      if (this.currentModel !== model) await this.setModel(model);
      if (effort !== undefined && this.currentEffort !== effort) await this.setEffort(effort);
    };
    try {
      for (const candidate of [...this.models]) {
        if (!isAntigravitySubscriptionModel(candidate.id) || candidate.id === model || !candidate.efforts?.length) continue;
        await restore(); await this.setModel(candidate.id);
      }
    } finally { await restore(); }
  }
  async dispatchPrompt(
    content: string | AcpRecord[],
    signal?: AbortSignal,
    lifecycle?: { sent(): void; response(outcome: AcpResponse): void },
  ): Promise<{ completion: Promise<AcpRecord> }> {
    if (!this.ready || !this.authenticated || !this.sessionId || this.busy) throw new AcpError(-32000);
    const epoch = this.cancelEpoch;
    this.busy = true;
    try {
      signal?.throwIfAborted();
      await this.options.assertSubscriptionOnly();
      signal?.throwIfAborted();
      if (!this.ready || epoch !== this.cancelEpoch) throw new Error('ANTIGRAVITY_CANCELLED_BEFORE_DISPATCH');
      let sent = false;
      const completion = this.client.request(
        'session/prompt',
        { sessionId: this.sessionId, prompt: typeof content === 'string' ? [{ type: 'text', text: content }] : content },
        60 * 60_000,
        () => { sent = true; lifecycle?.sent(); },
        outcome => {
          // The next frame in the same stdout chunk can already be background work.
          lifecycle?.response(outcome);
        },
      );
      if (!sent) await completion; // A transport rejection is not an accepted provider turn.
      return { completion: completion.finally(() => { this.busy = false; }) };
    } catch (error) { this.busy = false; throw error; }
  }
  async prompt(text: string, signal?: AbortSignal): Promise<AcpRecord> {
    return (await this.dispatchPrompt(text, signal)).completion;
  }
  cancel(): void {
    this.cancelEpoch++;
    for (const p of this.permissions) p.abort();
    if (this.ready && this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId });
  }
  async close(): Promise<void> { this.cancelEpoch++; this.ready = false; this.authenticated = false; for (const p of this.permissions) p.abort(); await this.client.close(); }
}
