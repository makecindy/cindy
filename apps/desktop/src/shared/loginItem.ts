/** OS-owned login startup setting; only the local desktop may change it. */
export interface LoginItemState {
  available: boolean;
  unavailableReason?: 'development' | 'platform';
  enabled: boolean;
  requiresApproval: boolean;
}

export const LOGIN_ITEM_GET_CHANNEL = 'login-item:get';
export const LOGIN_ITEM_SET_CHANNEL = 'login-item:set';
