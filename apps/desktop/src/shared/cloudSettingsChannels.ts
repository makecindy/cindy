/**
 * IPC channel names of the cloud settings client. Kept apart from its schemas so the main
 * window's preload takes only these names; Main validates every request.
 */
export const CLOUD_CLIENT_CHANNELS = {
  instanceAccess: 'cloud-settings-client:instance-access',
  instanceList: 'cloud-settings-client:instance-list',
  instanceCapacity: 'cloud-settings-client:instance-capacity',
  instanceClaim: 'cloud-settings-client:instance-claim',
  instanceInitialize: 'cloud-settings-client:instance-initialize',
  instanceLoginStart: 'cloud-settings-client:instance-login-start',
  instanceLoginDispatch: 'cloud-settings-client:instance-login-dispatch',
  instanceLoginPoll: 'cloud-settings-client:instance-login-poll',
  instanceLoginClose: 'cloud-settings-client:instance-login-close',
  instanceRead: 'cloud-settings-client:instance-read',
  instancePower: 'cloud-settings-client:instance-power',
  instanceUpgrade: 'cloud-settings-client:instance-upgrade',
  instancePolicy: 'cloud-settings-client:instance-policy',
  open: 'cloud-settings-client:open',
  read: 'cloud-settings-client:read',
  save: 'cloud-settings-client:save',
  receipt: 'cloud-settings-client:receipt',
  manage: 'cloud-settings-client:manage',
  cancelAuthorizations: 'cloud-settings-client:cancel-authorizations',
  close: 'cloud-settings-client:close',
} as const;
