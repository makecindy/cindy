import { MAKER_INVOKE, MAKER_SEND, MAKER_PUSH, TERMINAL_INVOKE, TERMINAL_PUSH } from './maker';
import { AGENT_ISLAND_CHANNELS } from './agent-island';
import { ANALYTICS_CHANNELS } from './analytics';
import { APP_CHANNELS } from './app';
import { APP_LOCALE_CHANNELS } from './app-locale';
import { APP_MENU_CHANNELS } from './app-menu';
import { APP_SHORTCUTS_CHANNELS } from './app-shortcuts';
import { APP_UPDATE_PROGRESS_CHANNELS } from './app-update-progress';
import { APPEARANCE_SETTINGS_CHANNELS } from './appearance-settings';
import { AUTH_CHANNELS } from './auth';
import { BINARY_DOWNLOAD_PROGRESS_CHANNELS } from './binary-download-progress';
import { BINDING_CHANNELS } from './binding';
import { BROWSER_CHANNELS } from './browser';
import { BROWSER_BACKEND_CHANNELS } from './browser-backend';
import { BROWSER_COMMENT_CHANNELS } from './browser-comment';
import { BUILTIN_API_KEY_HAS_CHANNELS } from './builtin-api-key-has';
import { BUILTIN_API_KEY_REMOVE_CHANNELS } from './builtin-api-key-remove';
import { BUILTIN_API_KEY_STORE_CHANNELS } from './builtin-api-key-store';
import { CC_CHANNELS } from './cc';
import { CHAT_ATTACHMENT_CHANNELS } from './chat-attachment';
import { CHECK_ENVIRONMENT_CHANNELS } from './check-environment';
import { CINDY_MEDIA_CHANNELS } from './cindy-media';
import { CLIENT_ENDPOINTS_CHANNELS } from './client-endpoints';
import { COMPUTER_DRIVER_UPDATE_PROGRESS_CHANNELS } from './computer-driver-update-progress';
import { DEEP_LINK_CHANNELS } from './deep-link';
import { DESKTOP_CHANNELS } from './desktop';
import { DESKTOP_CMD_CHANNELS } from './desktop-cmd';
import { DEV_CHANNELS } from './dev';
import { DEVICE_LINK_CHANNELS } from './device-link';
import { DIALOG_CHANNELS } from './dialog';
import { DINGTALK_BOT_CHANNELS } from './dingtalkbot';
import { DISCORD_BOT_CHANNELS } from './discordbot';
import { FEISHU_BOT_CHANNELS } from './feishubot';
import { FILE_CHANNELS } from './file';
import { FILE_BROWSER_CHANNELS } from './file-browser';
import { FIND_IN_PAGE_CHANNELS } from './find-in-page';
import { FS_CHANNELS } from './fs';
import { FULLSCREEN_CHANGE_CHANNELS } from './fullscreen-change';
import { GET_APP_DISPLAY_VERSION_INFO_CHANNELS } from './get-app-display-version-info';
import { GET_APP_VERSION_CHANNELS } from './get-app-version';
import { GET_DEVICE_ID_CHANNELS } from './get-device-id';
import { GET_FULLSCREEN_STATE_CHANNELS } from './get-fullscreen-state';
import { GET_OS_RELEASE_CHANNELS } from './get-os-release';
import { GHOST_PANEL_WINDOW_CHANNELS } from './ghost-panel-window';
import { GHOST_PIPE_CHANNELS } from './ghost-pipe';
import { GHOSTS_CHANNELS } from './ghosts';
import { GIT_CONTEXT_CHANNELS } from './git-context';
import { GIT_REVIEW_CHANNELS } from './git-review';
import { IMAGE_CACHE_CHANNELS } from './image-cache';
import { LAYOUT_CHANNELS } from './layout';
import { LEARN_CHANNELS } from './learn';
import { LEGACY_MIGRATION_CHANNELS } from './legacy-migration';
import { LOCAL_DB_CHANNELS } from './local-db';
import { LOCAL_THEMES_CHANNELS } from './local-themes';
import { LOG_UPLOAD_CHANNELS } from './log-upload';
import { MAKER_EXTRA_CHANNELS } from './maker-extra';
import { MEDIA_CHANNELS } from './media';
import { MODEL_ACCESS_CHANNELS } from './model-access';
import { NOTIFICATION_CHANNELS } from './notification';
import { OPEN_WITH_CHANNELS } from './open-with';
import { PAGE_ZOOM_CHANNELS } from './page-zoom';
import { PEEK_FILE_HEADER_CHANNELS } from './peek-file-header';
import { PLUGIN_MARKET_CHANNELS } from './plugin-market';
import { PROFILE_CHANNELS } from './profile';
import { READ_FILE_BYTES_CHANNELS } from './read-file-bytes';
import { READ_FILE_FOR_ATTACHMENT_CHANNELS } from './read-file-for-attachment';
import { RELEASE_NOTES_CHANNELS } from './release-notes';
import { REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS } from './remote-precreated-worktree-ledger';
import { RENDERER_CHANNELS } from './renderer';
import { RSB_BROWSER_BRIDGE_CHANNELS } from './rsb-browser-bridge';
import { RSB_NATIVE_POPUP_CHANNELS } from './rsb-native-popup';
import { SAFE_STORAGE_READ_CHANNELS } from './safe-storage-read';
import { SAFE_STORAGE_REMOVE_CHANNELS } from './safe-storage-remove';
import { SAFE_STORAGE_STORE_CHANNELS } from './safe-storage-store';
import { SELECTION_CONTEXT_MENU_CHANNELS } from './selection-context-menu';
import { SHELL_CHANNELS } from './shell';
import { SHOW_OPEN_DIRECTORY_DIALOG_CHANNELS } from './show-open-directory-dialog';
import { SIDEBAR_SETTINGS_CHANNELS } from './sidebar-settings';
import { SKILLHUB_CHANNELS } from './skillhub';
import { SYSTEM_CHANNELS } from './system';
import { TELEGRAM_BOT_CHANNELS } from './telegrambot';
import { TEXT_FILE_CHANNELS } from './text-file';
import { THEME_CHANNELS } from './theme';
import { UPDATE_AUTO_SETTINGS_GET_CHANNELS } from './update-auto-settings-get';
import { UPDATE_AUTO_SETTINGS_RESET_CHANNELS } from './update-auto-settings-reset';
import { UPDATE_AUTO_SETTINGS_SET_CHANNELS } from './update-auto-settings-set';
import { UPDATE_CHECK_NOW_CHANNELS } from './update-check-now';
import { UPDATE_CHECK_STARTUP_CHANNELS } from './update-check-startup';
import { UPDATE_GET_STATUS_CHANNELS } from './update-get-status';
import { UPDATE_MOVE_TO_APPLICATIONS_CHANNELS } from './update-move-to-applications';
import { UPDATE_RELAUNCH_CHANNELS } from './update-relaunch';
import { UPDATE_RELAUNCH_AUTO_CHANNELS } from './update-relaunch-auto';
import { UPDATE_SET_RELAUNCH_THEME_CHANNELS } from './update-set-relaunch-theme';
import { UPDATE_STATUS_CHANNELS } from './update-status';
import { USAGE_CHANNELS } from './usage';
import { VOICE_INPUT_CHANNELS } from './voice-input';
import { WECOM_BOT_CHANNELS } from './wecombot';
import { WECOM_GROUP_NOTIFICATION_CHANNELS } from './wecom-group-notification';
import { WECHAT_BOT_CHANNELS } from './wechatbot';
import { WINDOW_BEHAVIOR_CHANNELS } from './window-behavior';
import { WINDOW_CLOSE_CHANNELS } from './window-close';
import { WINDOW_CLOSE_SELF_CHANNELS } from './window-close-self';
import { WINDOW_DRAG_MOVE_START_CHANNELS } from './window-drag-move-start';
import { WINDOW_DRAG_MOVE_STOP_CHANNELS } from './window-drag-move-stop';
import { WINDOW_HIDDEN_CHANNELS } from './window-hidden';
import { WINDOW_MAXIMIZE_CHANNELS } from './window-maximize';
import { WINDOW_MINIMIZE_CHANNELS } from './window-minimize';
import { WORKSPACE_CHANNELS } from './workspace';
import { WORKTREE_CHANNELS } from './worktree';

export { MAKER_INVOKE, MAKER_SEND, MAKER_PUSH, TERMINAL_INVOKE, TERMINAL_PUSH } from './maker';
export { AGENT_ISLAND_CHANNELS } from './agent-island';
export { ANALYTICS_CHANNELS } from './analytics';
export { APP_CHANNELS } from './app';
export { APP_LOCALE_CHANNELS } from './app-locale';
export { APP_MENU_CHANNELS } from './app-menu';
export { APP_SHORTCUTS_CHANNELS } from './app-shortcuts';
export { APP_UPDATE_PROGRESS_CHANNELS } from './app-update-progress';
export { APPEARANCE_SETTINGS_CHANNELS } from './appearance-settings';
export { AUTH_CHANNELS } from './auth';
export { BINARY_DOWNLOAD_PROGRESS_CHANNELS } from './binary-download-progress';
export { BINDING_CHANNELS } from './binding';
export { BROWSER_CHANNELS } from './browser';
export { BROWSER_BACKEND_CHANNELS } from './browser-backend';
export { BROWSER_COMMENT_CHANNELS } from './browser-comment';
export { BUILTIN_API_KEY_HAS_CHANNELS } from './builtin-api-key-has';
export { BUILTIN_API_KEY_REMOVE_CHANNELS } from './builtin-api-key-remove';
export { BUILTIN_API_KEY_STORE_CHANNELS } from './builtin-api-key-store';
export { CC_CHANNELS } from './cc';
export { CHAT_ATTACHMENT_CHANNELS } from './chat-attachment';
export { CHECK_ENVIRONMENT_CHANNELS } from './check-environment';
export { CINDY_MEDIA_CHANNELS } from './cindy-media';
export { CLIENT_ENDPOINTS_CHANNELS } from './client-endpoints';
export { COMPUTER_DRIVER_UPDATE_PROGRESS_CHANNELS } from './computer-driver-update-progress';
export { DEEP_LINK_CHANNELS } from './deep-link';
export { DESKTOP_CHANNELS } from './desktop';
export { DESKTOP_CMD_CHANNELS } from './desktop-cmd';
export { DEV_CHANNELS } from './dev';
export { DEVICE_LINK_CHANNELS } from './device-link';
export { DIALOG_CHANNELS } from './dialog';
export { DINGTALK_BOT_CHANNELS } from './dingtalkbot';
export { DISCORD_BOT_CHANNELS } from './discordbot';
export { FEISHU_BOT_CHANNELS } from './feishubot';
export { FILE_CHANNELS } from './file';
export { FILE_BROWSER_CHANNELS } from './file-browser';
export { FIND_IN_PAGE_CHANNELS } from './find-in-page';
export { FS_CHANNELS } from './fs';
export { FULLSCREEN_CHANGE_CHANNELS } from './fullscreen-change';
export { GET_APP_DISPLAY_VERSION_INFO_CHANNELS } from './get-app-display-version-info';
export { GET_APP_VERSION_CHANNELS } from './get-app-version';
export { GET_DEVICE_ID_CHANNELS } from './get-device-id';
export { GET_FULLSCREEN_STATE_CHANNELS } from './get-fullscreen-state';
export { GET_OS_RELEASE_CHANNELS } from './get-os-release';
export { GHOST_PANEL_WINDOW_CHANNELS } from './ghost-panel-window';
export { GHOST_PIPE_CHANNELS } from './ghost-pipe';
export { GHOSTS_CHANNELS } from './ghosts';
export { GIT_CONTEXT_CHANNELS } from './git-context';
export { GIT_REVIEW_CHANNELS } from './git-review';
export { IMAGE_CACHE_CHANNELS } from './image-cache';
export { LAYOUT_CHANNELS } from './layout';
export { LEARN_CHANNELS } from './learn';
export { LEGACY_MIGRATION_CHANNELS } from './legacy-migration';
export { LOCAL_DB_CHANNELS } from './local-db';
export { LOCAL_THEMES_CHANNELS } from './local-themes';
export { LOG_UPLOAD_CHANNELS } from './log-upload';
export { MAKER_EXTRA_CHANNELS } from './maker-extra';
export { MEDIA_CHANNELS } from './media';
export { MODEL_ACCESS_CHANNELS } from './model-access';
export { NOTIFICATION_CHANNELS } from './notification';
export { OPEN_WITH_CHANNELS } from './open-with';
export { PAGE_ZOOM_CHANNELS } from './page-zoom';
export { PEEK_FILE_HEADER_CHANNELS } from './peek-file-header';
export { PLUGIN_MARKET_CHANNELS } from './plugin-market';
export { PROFILE_CHANNELS } from './profile';
export { READ_FILE_BYTES_CHANNELS } from './read-file-bytes';
export { READ_FILE_FOR_ATTACHMENT_CHANNELS } from './read-file-for-attachment';
export { RELEASE_NOTES_CHANNELS } from './release-notes';
export { REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS } from './remote-precreated-worktree-ledger';
export { RENDERER_CHANNELS } from './renderer';
export { RSB_BROWSER_BRIDGE_CHANNELS } from './rsb-browser-bridge';
export { RSB_NATIVE_POPUP_CHANNELS } from './rsb-native-popup';
export { SAFE_STORAGE_READ_CHANNELS } from './safe-storage-read';
export { SAFE_STORAGE_REMOVE_CHANNELS } from './safe-storage-remove';
export { SAFE_STORAGE_STORE_CHANNELS } from './safe-storage-store';
export { SELECTION_CONTEXT_MENU_CHANNELS } from './selection-context-menu';
export { SHELL_CHANNELS } from './shell';
export { SHOW_OPEN_DIRECTORY_DIALOG_CHANNELS } from './show-open-directory-dialog';
export { SIDEBAR_SETTINGS_CHANNELS } from './sidebar-settings';
export { SKILLHUB_CHANNELS } from './skillhub';
export { SYSTEM_CHANNELS } from './system';
export { TELEGRAM_BOT_CHANNELS } from './telegrambot';
export { TEXT_FILE_CHANNELS } from './text-file';
export { THEME_CHANNELS } from './theme';
export { UPDATE_AUTO_SETTINGS_GET_CHANNELS } from './update-auto-settings-get';
export { UPDATE_AUTO_SETTINGS_RESET_CHANNELS } from './update-auto-settings-reset';
export { UPDATE_AUTO_SETTINGS_SET_CHANNELS } from './update-auto-settings-set';
export { UPDATE_CHECK_NOW_CHANNELS } from './update-check-now';
export { UPDATE_CHECK_STARTUP_CHANNELS } from './update-check-startup';
export { UPDATE_GET_STATUS_CHANNELS } from './update-get-status';
export { UPDATE_MOVE_TO_APPLICATIONS_CHANNELS } from './update-move-to-applications';
export { UPDATE_RELAUNCH_CHANNELS } from './update-relaunch';
export { UPDATE_RELAUNCH_AUTO_CHANNELS } from './update-relaunch-auto';
export { UPDATE_SET_RELAUNCH_THEME_CHANNELS } from './update-set-relaunch-theme';
export { UPDATE_STATUS_CHANNELS } from './update-status';
export { USAGE_CHANNELS } from './usage';
export { VOICE_INPUT_CHANNELS } from './voice-input';
export { WECOM_BOT_CHANNELS } from './wecombot';
export { WECOM_GROUP_NOTIFICATION_CHANNELS } from './wecom-group-notification';
export { WECHAT_BOT_CHANNELS } from './wechatbot';
export { WINDOW_BEHAVIOR_CHANNELS } from './window-behavior';
export { WINDOW_CLOSE_CHANNELS } from './window-close';
export { WINDOW_CLOSE_SELF_CHANNELS } from './window-close-self';
export { WINDOW_DRAG_MOVE_START_CHANNELS } from './window-drag-move-start';
export { WINDOW_DRAG_MOVE_STOP_CHANNELS } from './window-drag-move-stop';
export { WINDOW_HIDDEN_CHANNELS } from './window-hidden';
export { WINDOW_MAXIMIZE_CHANNELS } from './window-maximize';
export { WINDOW_MINIMIZE_CHANNELS } from './window-minimize';
export { WORKSPACE_CHANNELS } from './workspace';
export { WORKTREE_CHANNELS } from './worktree';

export const IPC_CHANNELS = {
  MAKER_INVOKE,
  MAKER_SEND,
  MAKER_PUSH,
  TERMINAL_INVOKE,
  TERMINAL_PUSH,
  AGENT_ISLAND: AGENT_ISLAND_CHANNELS,
  ANALYTICS: ANALYTICS_CHANNELS,
  APP: APP_CHANNELS,
  APP_LOCALE: APP_LOCALE_CHANNELS,
  APP_MENU: APP_MENU_CHANNELS,
  APP_SHORTCUTS: APP_SHORTCUTS_CHANNELS,
  APP_UPDATE_PROGRESS: APP_UPDATE_PROGRESS_CHANNELS,
  APPEARANCE_SETTINGS: APPEARANCE_SETTINGS_CHANNELS,
  AUTH: AUTH_CHANNELS,
  BINARY_DOWNLOAD_PROGRESS: BINARY_DOWNLOAD_PROGRESS_CHANNELS,
  BINDING: BINDING_CHANNELS,
  BROWSER: BROWSER_CHANNELS,
  BROWSER_BACKEND: BROWSER_BACKEND_CHANNELS,
  BROWSER_COMMENT: BROWSER_COMMENT_CHANNELS,
  BUILTIN_API_KEY_HAS: BUILTIN_API_KEY_HAS_CHANNELS,
  BUILTIN_API_KEY_REMOVE: BUILTIN_API_KEY_REMOVE_CHANNELS,
  BUILTIN_API_KEY_STORE: BUILTIN_API_KEY_STORE_CHANNELS,
  CC: CC_CHANNELS,
  CHAT_ATTACHMENT: CHAT_ATTACHMENT_CHANNELS,
  CHECK_ENVIRONMENT: CHECK_ENVIRONMENT_CHANNELS,
  CINDY_MEDIA: CINDY_MEDIA_CHANNELS,
  CLIENT_ENDPOINTS: CLIENT_ENDPOINTS_CHANNELS,
  COMPUTER_DRIVER_UPDATE_PROGRESS: COMPUTER_DRIVER_UPDATE_PROGRESS_CHANNELS,
  DEEP_LINK: DEEP_LINK_CHANNELS,
  DESKTOP: DESKTOP_CHANNELS,
  DESKTOP_CMD: DESKTOP_CMD_CHANNELS,
  DEV: DEV_CHANNELS,
  DEVICE_LINK: DEVICE_LINK_CHANNELS,
  DIALOG: DIALOG_CHANNELS,
  DINGTALK_BOT: DINGTALK_BOT_CHANNELS,
  DISCORD_BOT: DISCORD_BOT_CHANNELS,
  FEISHU_BOT: FEISHU_BOT_CHANNELS,
  FILE: FILE_CHANNELS,
  FILE_BROWSER: FILE_BROWSER_CHANNELS,
  FIND_IN_PAGE: FIND_IN_PAGE_CHANNELS,
  FS: FS_CHANNELS,
  FULLSCREEN_CHANGE: FULLSCREEN_CHANGE_CHANNELS,
  GET_APP_DISPLAY_VERSION_INFO: GET_APP_DISPLAY_VERSION_INFO_CHANNELS,
  GET_APP_VERSION: GET_APP_VERSION_CHANNELS,
  GET_DEVICE_ID: GET_DEVICE_ID_CHANNELS,
  GET_FULLSCREEN_STATE: GET_FULLSCREEN_STATE_CHANNELS,
  GET_OS_RELEASE: GET_OS_RELEASE_CHANNELS,
  GHOST_PANEL_WINDOW: GHOST_PANEL_WINDOW_CHANNELS,
  GHOST_PIPE: GHOST_PIPE_CHANNELS,
  GHOSTS: GHOSTS_CHANNELS,
  GIT_CONTEXT: GIT_CONTEXT_CHANNELS,
  GIT_REVIEW: GIT_REVIEW_CHANNELS,
  IMAGE_CACHE: IMAGE_CACHE_CHANNELS,
  LAYOUT: LAYOUT_CHANNELS,
  LEARN: LEARN_CHANNELS,
  LEGACY_MIGRATION: LEGACY_MIGRATION_CHANNELS,
  LOCAL_DB: LOCAL_DB_CHANNELS,
  LOCAL_THEMES: LOCAL_THEMES_CHANNELS,
  LOG_UPLOAD: LOG_UPLOAD_CHANNELS,
  MAKER_EXTRA: MAKER_EXTRA_CHANNELS,
  MEDIA: MEDIA_CHANNELS,
  MODEL_ACCESS: MODEL_ACCESS_CHANNELS,
  NOTIFICATION: NOTIFICATION_CHANNELS,
  OPEN_WITH: OPEN_WITH_CHANNELS,
  PAGE_ZOOM: PAGE_ZOOM_CHANNELS,
  PEEK_FILE_HEADER: PEEK_FILE_HEADER_CHANNELS,
  PLUGIN_MARKET: PLUGIN_MARKET_CHANNELS,
  PROFILE: PROFILE_CHANNELS,
  READ_FILE_BYTES: READ_FILE_BYTES_CHANNELS,
  READ_FILE_FOR_ATTACHMENT: READ_FILE_FOR_ATTACHMENT_CHANNELS,
  RELEASE_NOTES: RELEASE_NOTES_CHANNELS,
  REMOTE_PRECREATED_WORKTREE_LEDGER: REMOTE_PRECREATED_WORKTREE_LEDGER_CHANNELS,
  RENDERER: RENDERER_CHANNELS,
  RSB_BROWSER_BRIDGE: RSB_BROWSER_BRIDGE_CHANNELS,
  RSB_NATIVE_POPUP: RSB_NATIVE_POPUP_CHANNELS,
  SAFE_STORAGE_READ: SAFE_STORAGE_READ_CHANNELS,
  SAFE_STORAGE_REMOVE: SAFE_STORAGE_REMOVE_CHANNELS,
  SAFE_STORAGE_STORE: SAFE_STORAGE_STORE_CHANNELS,
  SELECTION_CONTEXT_MENU: SELECTION_CONTEXT_MENU_CHANNELS,
  SHELL: SHELL_CHANNELS,
  SHOW_OPEN_DIRECTORY_DIALOG: SHOW_OPEN_DIRECTORY_DIALOG_CHANNELS,
  SIDEBAR_SETTINGS: SIDEBAR_SETTINGS_CHANNELS,
  SKILLHUB: SKILLHUB_CHANNELS,
  SYSTEM: SYSTEM_CHANNELS,
  TELEGRAM_BOT: TELEGRAM_BOT_CHANNELS,
  TEXT_FILE: TEXT_FILE_CHANNELS,
  THEME: THEME_CHANNELS,
  UPDATE_AUTO_SETTINGS_GET: UPDATE_AUTO_SETTINGS_GET_CHANNELS,
  UPDATE_AUTO_SETTINGS_RESET: UPDATE_AUTO_SETTINGS_RESET_CHANNELS,
  UPDATE_AUTO_SETTINGS_SET: UPDATE_AUTO_SETTINGS_SET_CHANNELS,
  UPDATE_CHECK_NOW: UPDATE_CHECK_NOW_CHANNELS,
  UPDATE_CHECK_STARTUP: UPDATE_CHECK_STARTUP_CHANNELS,
  UPDATE_GET_STATUS: UPDATE_GET_STATUS_CHANNELS,
  UPDATE_MOVE_TO_APPLICATIONS: UPDATE_MOVE_TO_APPLICATIONS_CHANNELS,
  UPDATE_RELAUNCH: UPDATE_RELAUNCH_CHANNELS,
  UPDATE_RELAUNCH_AUTO: UPDATE_RELAUNCH_AUTO_CHANNELS,
  UPDATE_SET_RELAUNCH_THEME: UPDATE_SET_RELAUNCH_THEME_CHANNELS,
  UPDATE_STATUS: UPDATE_STATUS_CHANNELS,
  USAGE: USAGE_CHANNELS,
  VOICE_INPUT: VOICE_INPUT_CHANNELS,
  WECOM_BOT: WECOM_BOT_CHANNELS,
  WECOM_GROUP_NOTIFICATION: WECOM_GROUP_NOTIFICATION_CHANNELS,
  WECHAT_BOT: WECHAT_BOT_CHANNELS,
  WINDOW_BEHAVIOR: WINDOW_BEHAVIOR_CHANNELS,
  WINDOW_CLOSE: WINDOW_CLOSE_CHANNELS,
  WINDOW_CLOSE_SELF: WINDOW_CLOSE_SELF_CHANNELS,
  WINDOW_DRAG_MOVE_START: WINDOW_DRAG_MOVE_START_CHANNELS,
  WINDOW_DRAG_MOVE_STOP: WINDOW_DRAG_MOVE_STOP_CHANNELS,
  WINDOW_HIDDEN: WINDOW_HIDDEN_CHANNELS,
  WINDOW_MAXIMIZE: WINDOW_MAXIMIZE_CHANNELS,
  WINDOW_MINIMIZE: WINDOW_MINIMIZE_CHANNELS,
  WORKSPACE: WORKSPACE_CHANNELS,
  WORKTREE: WORKTREE_CHANNELS,
} as const;

type ValueOf<T> = T[keyof T];
type NestedValueOf<T> = T extends string ? T : T extends Record<string, unknown> ? NestedValueOf<ValueOf<T>> : never;

export type IpcChannel = NestedValueOf<typeof IPC_CHANNELS>;
export type InvokeChannel = IpcChannel;
export type SendChannel = IpcChannel;
export type PushChannel = IpcChannel;
