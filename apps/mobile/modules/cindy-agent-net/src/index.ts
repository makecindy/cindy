import { requireOptionalNativeModule } from 'expo-modules-core';

export interface AgentNetNativeModule {
  create(options: string): Promise<string>;
  command(id: string, command: string): Promise<string>;
  destroy(id: string): Promise<void>;
  /**
   * `native-wait` binaries (the engine's `identity().features`): resolves true as soon as the engine has something to read
   * with the `poll` command, false after `maxMs`. Meanwhile the engine receives, acknowledges and runs its timers by itself.
   */
  wait?(id: string, maxMs: number): Promise<boolean>;
  /**
   * `binary-io` binaries: one frame in, one out (`encodeNativeIo` in @cindy/agent-net). With `waitMs` > 0 it first waits as
   * `wait` does and reads only once the engine has something for JS (an empty array otherwise). `kick`: afterwards a waiting
   * call reads if the engine has something for JS.
   */
  io?(id: string, input: Uint8Array, waitMs: number, kick: boolean): Promise<Uint8Array>;
  /** `binary-io` binaries: a waiting `io` call returns now and reads. Synchronous and cheap. */
  kick?(id: string): void;
  beginNotificationScope?(): string;
  notificationScope?(): string | null;
  openNotification?(link: string): string | null;
  configureNotifications?(ticket: string, raw: string): Promise<void>;
  startLan?(port: number, txt: string): Promise<string>;
  updateLan?(id: string, txt: string): Promise<void>;
  stopLan?(id: string): Promise<void>;
  addListener(event: 'onLanService', listener: (event: { id: string; port: number; addresses: string[]; txt: Record<string, string> }) => void): { remove(): void };
}
// Existing installations keep their current V1 behavior. They cannot advertise
// V2 until a matching cold-update binary supplies this module.
export const agentNetNative = requireOptionalNativeModule<AgentNetNativeModule>('CindyAgentNet');
