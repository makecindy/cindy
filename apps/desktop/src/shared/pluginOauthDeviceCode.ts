/** Local Desktop presentation only. Never add this channel to device-link or chat snapshots. */
export const PLUGIN_OAUTH_DEVICE_CODE_CHANNEL = 'plugin-oauth:device-code';

export interface PluginOauthDeviceCodeTarget {
  deviceId: string;
  ghostId: string;
  requestId: string;
  actionId: string;
}

export type PluginOauthDeviceCodeRequest = PluginOauthDeviceCodeTarget & {
  operation: 'read' | 'copy' | 'reopen';
};

/** Only the short user-entered device code is displayable, never OAuth callback codes or tokens. */
export type PluginOauthDeviceCodeView =
  | {
      phase: 'ready';
      userCode: string;
      verificationHost: string;
      expiresAt: number;
      copiedAt: number;
    }
  | { phase: 'browser'; expiresAt: number }
  | { phase: 'completed' | 'expired' | 'ended' };

export interface PluginOauthDeviceCodePrompt {
  userCode: string;
  authorizeUrl: string;
  expiresAt: number;
}

export type PluginOauthDeviceCodeClose = (phase: 'completed' | 'expired' | 'ended') => void;
