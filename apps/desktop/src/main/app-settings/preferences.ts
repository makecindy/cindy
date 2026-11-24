import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { APP_PREFERENCE_REQUEST, APP_PREFERENCE_REPLY, appPreferenceSchema,
  type AppPreferenceRequest } from '../../shared/appPreferenceControl.js';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

const replySchema = z.strictObject({ requestId: z.string().uuid(), ok: z.boolean(), code: z.literal('CONFLICT').optional(),
  state: appPreferenceSchema.required().optional(), themeFamilies: z.array(z.string().max(256)).max(256).optional(),
  modelVisibility: z.strictObject({ visible: z.boolean(), customized: z.boolean() }).optional(),
  modelEngines: z.record(z.string().max(4096), z.enum(['cc', 'codex', 'pi'])).optional(),
  userPrompt: z.string().max(8000).optional(),
  modelEfforts: z.record(z.string().max(4096), z.record(z.string().max(4096), z.string().max(64))).optional() });
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
/** Fields the cloud build adds to a request; each belongs to its own operation. */
export type AppPreferenceExtras = Pick<AppPreferenceRequest, 'modelEngine' | 'userPrompt' | 'modelEffort'>;
export async function manageAppPreferences(operation: AppPreferenceRequest['operation'], patch?: Record<string, unknown>, modelVisibility?: AppPreferenceRequest['modelVisibility'], extras: AppPreferenceExtras & { expected?: Readonly<Record<string, unknown>> } = {}) {
  if (extras.userPrompt !== undefined && extras.userPrompt.length > 8000) throw new Error('USER_PROMPT_TOO_LONG');
  const window = getDeepLinkMainWindow();
  if (!window || window.isDestroyed()) throw new Error('PREFERENCE_WINDOW_NOT_READY');
  const parsedPatch = patch === undefined ? undefined : appPreferenceSchema.parse(patch);
  const { expected, ...requestExtras } = extras;
  const parsedExpected = expected === undefined ? undefined : appPreferenceSchema.parse(expected);
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
      if (!result.ok || !result.state) reject(new Error(result.code === 'CONFLICT' ? '[CONFLICT] Preferences changed since they were read' : 'PREFERENCE_NOT_SAVED'));
      else resolve(result);
    } });
    try {
      window.webContents.send(APP_PREFERENCE_REQUEST, { requestId, ownerStamp: getActiveDataOwnerPushStamp(),
        expiresAt: Date.now() + 5000, operation, ...(modelVisibility ? { modelVisibility } : {}),
        ...Object.fromEntries(Object.entries(requestExtras).filter(([, value]) => value !== undefined)),
        ...(parsedPatch ? { patch: parsedPatch } : {}), ...(parsedExpected ? { expected: parsedExpected } : {}) } satisfies AppPreferenceRequest);
    } catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
  });
  assertOwner();
  if (parsedPatch && Object.entries(parsedPatch).some(([key, value]) => reply.state?.[key as keyof typeof parsedPatch] !== value))
    throw new Error('PREFERENCE_READBACK_MISMATCH');
  return { value: reply.state, themeFamilies: reply.themeFamilies, ...(reply.modelVisibility ? { modelVisibility: reply.modelVisibility } : {}),
    ...(reply.modelEngines ? { modelEngines: reply.modelEngines } : {}), ...(reply.userPrompt !== undefined ? { userPrompt: reply.userPrompt } : {}),
    ...(reply.modelEfforts ? { modelEfforts: reply.modelEfforts } : {}) };
}
