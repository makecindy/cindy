/** 同账号供应商管理。沿用 provider-group:remote，由组所在电脑校验并执行。 */
import type {
  ProviderGroupCommandResult,
  ProviderGroupLocalCommand,
} from './providerGroup';
import type { ProviderShareCommand, ProviderShareCommandResult } from './providerShare';

export type ProviderGroupManagementCommand = Extract<
  ProviderGroupLocalCommand,
  { action: 'get' | 'candidates' | 'save-if-current' | 'delete-if-current' }
>;

export type ProviderShareManagementCommand = Extract<
  ProviderShareCommand,
  { action: 'owned' | 'own-usage' | 'usage-history' | 'create-link' | 'approve' | 'reject' | 'set-member' | 'reshare-decide' | 'get-run-limits' | 'set-run-limits' | 'reset-run-limits' }
>;

export type ProviderManagementRequest =
  | { action: 'manage-group'; command: ProviderGroupManagementCommand }
  | { action: 'manage-share'; command: ProviderShareManagementCommand };

export type ProviderManagementResult<R extends ProviderManagementRequest> =
  R extends { action: 'manage-group'; command: infer C extends ProviderGroupManagementCommand }
    ? ProviderGroupCommandResult<C>
    : R extends { action: 'manage-share'; command: infer C extends ProviderShareManagementCommand }
      ? ProviderShareCommandResult[C['action']]
      : never;

/** respondedAt 用于把分享链接的有效时间换算到控制端，避免两台电脑时钟不同。 */
export interface ProviderManagementReply {
  result: unknown;
  respondedAt: number;
}

export function isProviderManagementRequest(raw: unknown): raw is ProviderManagementRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return value.action === 'manage-group' || value.action === 'manage-share';
}
