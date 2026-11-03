/**
 * Host confirmation cards raised by the Agent app-update tools. They reuse the
 * generic `permission` interaction, so Desktop, same-account phones and IM cards
 * render them without upgrades. Only the owner may answer them: shared-task
 * guests are refused by name at the device-link boundary.
 */
export const AGENT_APP_UPDATE_TOOL_NAME = 'cindy.app.update';
export const AGENT_APP_AUTO_UPDATE_TOOL_NAME = 'cindy.app.auto_update';

export const AGENT_APP_UPDATE_HOST_CONFIRMATION = 'app_update';

/** Owner-only Host cards; shared-task guests may not answer these. */
export const OWNER_ONLY_HOST_CONFIRMATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  AGENT_APP_UPDATE_TOOL_NAME,
  AGENT_APP_AUTO_UPDATE_TOOL_NAME,
]);
