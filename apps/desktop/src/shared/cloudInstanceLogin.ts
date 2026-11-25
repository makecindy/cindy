import { z } from 'zod';
import type { DesktopLoginState } from './authIpc';

const contact = z.string().trim().min(1).max(254);
export const cloudLoginActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reset') }),
  z.strictObject({ type: z.literal('back') }),
  z.strictObject({ type: z.literal('cancel-browser') }),
  z.strictObject({ type: z.literal('discover'), email: contact }),
  z.strictObject({ type: z.literal('discover-sso-org'), org: contact }),
  z
    .strictObject({
      type: z.literal('request-code'),
      kind: z.enum(['phone', 'email']),
      identifier: contact,
      captchaToken: z.string().max(8192).optional(),
    }),
  z
    .strictObject({
      type: z.literal('verify-code'),
      kind: z.enum(['phone', 'email']),
      identifier: contact,
      code: z.string().regex(/^\d{6}$/u),
    }),
  z
    .strictObject({
      type: z.literal('start-browser'),
      kind: z.enum(['social', 'sso']),
      providerOrConnectionId: z.string().min(1).max(256),
      label: z.string().max(256),
    }),
  z.strictObject({ type: z.literal('request-sso-verification-code') }),
  z.strictObject({ type: z.literal('verify-sso-verification'), code: z.string().min(1).max(16) }),
  z.strictObject({ type: z.literal('request-binding-code'), contact }),
  z
    .strictObject({ type: z.literal('verify-binding'), contact, code: z.string().regex(/^\d{6}$/u) }),
]);
export type CloudLoginAction = z.infer<typeof cloudLoginActionSchema>;
export const cloudLoginHandleSchema = z.strictObject({ handle: z.string().uuid() });
export const cloudLoginDispatchSchema = cloudLoginHandleSchema
  .extend({ action: cloudLoginActionSchema })
  .strict();
/** UI only. CIS capabilities, PKCE proofs, tickets and credentials stay in Main/CIS. */
export interface CloudInstanceLoginView {
  handle: string;
  state: DesktopLoginState;
  complete: boolean;
  captchaChallengeUrl?: string;
  errorCode?: string;
  retryAt?: number;
}
