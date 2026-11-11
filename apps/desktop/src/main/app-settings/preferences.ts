import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { APP_PREFERENCE_REQUEST, APP_PREFERENCE_REPLY, appPreferenceSchema,
  type AppPreferenceRequest } from '../../shared/appPreferenceControl.js';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

const replySchema = z.strictObject({ requestId: z.string().uuid(), ok: z.boolean(),
  state: appPreferenceSchema.required().optional(), themeFamilies: z.array(z.string().max(256)).max(256).optional(),
  modelVisibility: z.strictObject({ visible: z.boolean(), customized: z.boolean() }).optional() });
const pending = new Map<string, { senderId: number; settle: (value: unknown) => void }>();
export function registerPreferenceControlIpc(): void {
  ipcMain.on(APP_PREFERENCE_REPLY, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const parsed = replySchema.safeParse(raw);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.requestId);
    if (request?.senderId === event.sender.id) request.settle(parsed.data);
  });
}

/** Finite host→main-window request; no arbitrary renderer command or storage key. */
export async function manageAppPreferences(operation: AppPreferenceRequest['operation'], patch?: Record<string, unknown>, modelVisibility?: AppPreferenceRequest['modelVisibility']) {
  const window = getDeepLinkMainWindow();
  if (!window || window.isDestroyed()) throw new Error('PREFERENCE_WINDOW_NOT_READY');
  const parsedPatch = patch === undefined ? undefined : appPreferenceSchema.parse(patch);
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throw new Error('OWNER_SCOPE_CHANGED');
  };
  assertOwner();
  const requestId = randomUUID();
  const reply = await new Promise<z.infer<typeof replySchema>>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('PREFERENCE_CONFIRMATION_TIMEOUT')); }, 5000);
    pending.set(requestId, { senderId: window.webContents.id, settle: value => {
      pending.delete(requestId); clearTimeout(timer);
      const result = replySchema.parse(value);
      if (!result.ok || !result.state) reject(new Error('PREFERENCE_NOT_SAVED'));
      else resolve(result);
    } });
    try {
      window.webContents.send(APP_PREFERENCE_REQUEST, { requestId, ownerStamp: getActiveDataOwnerPushStamp(),
        expiresAt: Date.now() + 5000, operation, ...(modelVisibility ? { modelVisibility } : {}), ...(parsedPatch ? { patch: parsedPatch } : {}) } satisfies AppPreferenceRequest);
    } catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
  });
  assertOwner();
  if (parsedPatch && Object.entries(parsedPatch).some(([key, value]) => reply.state?.[key as keyof typeof parsedPatch] !== value))
    throw new Error('PREFERENCE_READBACK_MISMATCH');
  return { value: reply.state, themeFamilies: reply.themeFamilies, ...(reply.modelVisibility ? { modelVisibility: reply.modelVisibility } : {}) };
}
