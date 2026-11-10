// The profile root is injected at startup (see main/userDataPath.ts) instead of
// being read from Electron, so unit tests that reach storage modules need the
// same value Electron's stub used to provide.
import { app } from 'electron';
import { configureUserDataDir } from '../../main/userDataPath';

configureUserDataDir(app.getPath('userData'));
