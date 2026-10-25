import { ipcMain, net } from 'electron';

import {
  captureImAccountGeneration,
  ImAccountScopeClosedError,
  isImAccountGenerationCurrent,
  runInImAccountGeneration,
} from './im/accountBoundary';
import { ownerScopedImSecrets } from './im/ownerScopedStorage';
import { createLogger } from './logger';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';

import { WecomGroupNotificationService as SharedService, parseTestMessage } from '@cindy/im-runtime/wecomGroupNotification';
export { __testing, type WecomGroupNotificationState, type WecomGroupNotificationPublisher } from '@cindy/im-runtime/wecomGroupNotification';
export class WecomGroupNotificationService extends SharedService {
  constructor(fetchImpl: ConstructorParameters<typeof SharedService>[0] = (input, init) => net.fetch(input, init), secrets: ConstructorParameters<typeof SharedService>[1] = ownerScopedImSecrets) {
    super(fetchImpl, secrets, { account: { captureImAccountGeneration, isImAccountGenerationCurrent }, log: createLogger('wecom-group-notification') });
  }
}
export const wecomGroupNotificationService = new WecomGroupNotificationService();

export function initWecomGroupNotificationIpc(): void {
  const runAccountScoped = <T>(
    operation: (accountGeneration: number) => T | Promise<T>,
  ): Promise<T> => {
    const accountGeneration = captureImAccountGeneration();
    if (accountGeneration === null) {
      return Promise.reject(new ImAccountScopeClosedError());
    }
    return runInImAccountGeneration(accountGeneration, async () => operation(accountGeneration));
  };

  ipcMain.handle('wecomGroupNotification:get-state', (event) => {
    assertTrustedAppRendererEvent(event);
    return wecomGroupNotificationService.getState();
  });
  ipcMain.handle(
    'wecomGroupNotification:save-and-test',
    async (event, webhookUrl: unknown, testMessage: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (typeof webhookUrl !== 'string') throw new TypeError('webhookUrl must be a string');
      const accountGeneration = captureImAccountGeneration();
      if (accountGeneration === null) throw new ImAccountScopeClosedError();
      return runInImAccountGeneration(accountGeneration, () =>
        wecomGroupNotificationService.saveAndTest(webhookUrl, parseTestMessage(testMessage), () =>
          isImAccountGenerationCurrent(accountGeneration),
        ),
      );
    },
  );
  ipcMain.handle('wecomGroupNotification:test', async (event, testMessage: unknown) => {
    assertTrustedAppRendererEvent(event);
    return runAccountScoped(async (accountGeneration) => {
      await wecomGroupNotificationService.test(parseTestMessage(testMessage), () =>
        isImAccountGenerationCurrent(accountGeneration),
      );
      return { ok: true as const };
    });
  });
  ipcMain.handle('wecomGroupNotification:set-enabled', (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return runAccountScoped(() => wecomGroupNotificationService.setEnabled(enabled));
  });
  ipcMain.handle('wecomGroupNotification:clear', (event) => {
    assertTrustedAppRendererEvent(event);
    return runAccountScoped(() => wecomGroupNotificationService.clear());
  });
}
