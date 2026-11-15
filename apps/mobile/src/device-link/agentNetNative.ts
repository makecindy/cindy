import type { NativeEnginePort } from '@cindy/agent-net/portable';
import { agentNetNative } from '../../modules/cindy-agent-net/src';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';

export interface NativeAgentNetIdentity {
  deviceId: string;
  signingKey: string;
  transportKey: string;
  udpPort: number | null;
}
export interface NativeAgentNetOptions {
  seed: string;
  context: string;
  deviceId: string;
  legacySigning?: boolean;
  udp?: boolean;
}
/** Trusted app adapter. Private seeds never enter AsyncStorage, logs or an RPC. */
export class MobileAgentNetEngine implements NativeEnginePort {
  private destroyed = false;
  private unsubscribe: (() => void) | null = null;
  private constructor(
    private readonly handle: string,
    readonly identity: NativeAgentNetIdentity,
    readonly assertCurrent: () => void,
  ) {}

  static available(): boolean { return agentNetNative !== null; }
  static async create(options: NativeAgentNetOptions, routeGuard: () => void): Promise<MobileAgentNetEngine> {
    if (!agentNetNative) throw new Error('AGENT_NET_NATIVE_BINARY_REQUIRED');
    const owner = getMobileAuthOwner();
    const guard = () => {
      if (!owner.accountId || !isMobileAuthOwnerCurrent(owner)) throw new Error('AGENT_NET_OWNER_CHANGED');
      routeGuard();
    };
    guard();
    const handle = await agentNetNative.create(JSON.stringify(options));
    let value: MobileAgentNetEngine | null = null;
    try {
      guard();
      const response = JSON.parse(await agentNetNative.command(handle, '{"op":"identity"}')) as {
        ok: boolean; value?: NativeAgentNetIdentity;
      };
      guard();
      if (!response.ok || !response.value || response.value.deviceId !== options.deviceId) throw new Error('AGENT_NET_NATIVE_IDENTITY_MISMATCH');
      value = new MobileAgentNetEngine(handle, response.value, guard);
      value.unsubscribe = subscribeMobileAuthOwner(() => {
        try { guard(); } catch { void value?.destroy(); }
      });
      return value;
    } catch (error) { await agentNetNative.destroy(handle).catch(() => undefined); throw error; }
  }
  async command<T = unknown>(command: Record<string, unknown>): Promise<T> {
    if (this.destroyed || !agentNetNative) throw new Error('AGENT_NET_ENGINE_CLOSED');
    this.assertCurrent();
    const result = await agentNetNative.command(this.handle, JSON.stringify(command));
    try { this.assertCurrent(); }
    catch (error) { void this.destroy(); throw error; }
    if (this.destroyed) throw new Error('AGENT_NET_ENGINE_CLOSED');
    const response = JSON.parse(result) as { ok: boolean; value?: T; code?: string };
    if (!response.ok) throw new Error(response.code || 'AGENT_NET_NATIVE_COMMAND_FAILED');
    return response.value as T;
  }
  sign(text: string): Promise<string> { return this.command({ op: 'sign', text }); }
  random(): Promise<string> { return this.command({ op: 'random' }); }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    await agentNetNative?.destroy(this.handle).catch(() => undefined);
  }
}
