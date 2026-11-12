import { requireOptionalNativeModule } from 'expo-modules-core';

export interface AgentNetNativeModule {
  create(options: string): Promise<string>;
  command(id: string, command: string): Promise<string>;
  destroy(id: string): Promise<void>;
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
