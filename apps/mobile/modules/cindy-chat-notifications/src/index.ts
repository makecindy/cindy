import { requireOptionalNativeModule } from 'expo-modules-core';
export interface ChatNotificationsNative {
  configure(owner: string, actor: string, baseUrl: string, accessToken: string, title: string, stopLabel: string, preview: boolean, language?: string): Promise<void>;
  stop(): Promise<void>;
  isPaused(): Promise<boolean>;
  resume(): Promise<void>;
  setIdentity(actor: string): Promise<void>;
  setPreview(enabled: boolean): Promise<void>;
  getDiagnostics?(): Promise<Record<string, unknown>>;
  configureSessionRelay?(owner: string, user: string, device: string, url: string, token: string, targets: string): Promise<void>;
  clearSessionRelay?(): Promise<void>;
  setSessionRelayBackground?(enabled: boolean): Promise<void>;
  receiveSessionNotification?(owner: string, device: string, payload: string): Promise<void>;
  addListener(event: 'refreshRequested', listener: () => void): { remove(): void };
}
export default requireOptionalNativeModule<ChatNotificationsNative>('CindyChatNotifications');
