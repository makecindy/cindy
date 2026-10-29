import { requireOptionalNativeModule } from 'expo-modules-core';
export interface ChatNotificationsNative {
  configure(owner: string, actor: string, baseUrl: string, accessToken: string, title: string, stopLabel: string, preview: boolean, language?: string): Promise<void>;
  stop(): Promise<void>;
  isPaused(): Promise<boolean>;
  resume(): Promise<void>;
  setIdentity(actor: string): Promise<void>;
  setPreview(enabled: boolean): Promise<void>;
  addListener(event: 'refreshRequested', listener: () => void): { remove(): void };
}
export default requireOptionalNativeModule<ChatNotificationsNative>('CindyChatNotifications');
