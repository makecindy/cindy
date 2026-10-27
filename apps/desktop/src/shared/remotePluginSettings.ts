export const REMOTE_PLUGIN_SETTINGS_PARTITION = 'remote-plugin-settings:';
export const REMOTE_PLUGIN_SETTINGS_OPEN = 'device-link:plugin-settings:open';
export const REMOTE_PLUGIN_SETTINGS_CLOSE = 'device-link:plugin-settings:close';
export const REMOTE_PLUGIN_SETTINGS_DIRECTORY = 'device-link:plugin-settings:directory';
export const REMOTE_PLUGIN_SETTINGS_DIRECTORY_ANSWER =
  'device-link:plugin-settings:answer-directory';

export interface RemotePluginSettingsTarget {
  deviceId: string;
  instanceId: string;
  expectedInstalledApproval: string;
}
export interface RemotePluginSettingsView {
  id: string;
  partition: string;
  src: string;
}
export interface RemotePluginSettingsDirectory {
  viewId: string;
  request: import('@cindy/device-link').PluginDirectoryRequest;
}
export interface RemotePluginSettingsDirectoryAnswer {
  viewId: string;
  requestId: string;
  path: string | null;
}
