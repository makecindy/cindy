// The profile root is injected at startup (see main/userDataPath.ts) instead of
// being read from Electron, so unit tests that reach storage modules need the
// same value Electron's stub used to provide.
import { app } from 'electron';
import { configureAppDataDir, configureUserDataDir } from '../../main/userDataPath';

configureUserDataDir(app.getPath('userData'));
// Desktop startup injects both roots (main/index.ts); so do the tests.
configureAppDataDir(app.getPath('appData'));

// The Codex CLI home now honours `CODEX_HOME` (absolute paths only). An ambient
// value would make credential tests read — and the reconcile path write — the
// developer's real `~/.codex/auth.json`, so the suite starts without it. The
// cases that need a custom home stub it themselves.
delete process.env.CODEX_HOME;
