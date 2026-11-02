import { app } from 'electron';

/** Shared-profile previews do not own the bot's process-wide presence notices. */
export function shouldAnnounceFeishuLifecycle(): boolean {
  // Read at send time: host modules can load before bootstrap resolves the profile.
  // A genuinely isolated sandbox still owns its own configured bot connection.
  return app.isPackaged || process.env.XDT_PASSIVE_SHARED_USER_DATA !== '1';
}
