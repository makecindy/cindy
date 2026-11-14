import { app } from 'electron';
import { createCodexLocalSessions } from './codexLocalSessionsCore.js';

// Read on every call: Desktop can temporarily switch userData after bootstrap.
export const desktopCodexLocalSessions = createCodexLocalSessions({
  getUserDataDir: () => app.getPath('userData'),
});
