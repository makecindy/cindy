import { setPreserveUnreadableSettingsFilesByDefault } from '../../desktop/src/main/maker-host/override-settings-file.js';

// The boot layer, right after boot-env.ts: main.ts imports this module second, before any
// module can read a settings file. While the Host shares a settings directory with the desktop
// window process, it never deletes a user settings file it cannot read: every store without its
// own preserveUnreadableFile keeps such a file, reads the defaults and refuses ordinary writes
// (release table, section two). The desktop never sets this default.
setPreserveUnreadableSettingsFilesByDefault(true);
