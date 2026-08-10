import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { utilityProcess } from 'electron';

import { createLogger } from '../logger.js';
import { focusMainWindow, openMainWindowSession } from '../deepLink.js';
import {
  WorkLouderCodexHostClient,
  type WorkLouderSdkLocation,
} from './WorkLouderCodexHostClient.js';
import { WorkLouderCodexLightingController } from './WorkLouderCodexLightingController.js';

const log = createLogger('worklouder-codex');
const requireFromMain = createRequire(__filename);

function resolveWorkLouderSdk(): WorkLouderSdkLocation | null {
  try {
    return {
      entry: requireFromMain.resolve('@worklouder/device-kit-oai'),
      source: 'cindy-package',
    };
  } catch {
    // The official SDK is optional until Work Louder grants Cindy registry access.
  }

  if (process.platform !== 'darwin') return null;
  for (const appName of ['ChatGPT.app', 'Codex.app']) {
    const packageDir = path.join(
      '/Applications',
      appName,
      'Contents',
      'Resources',
      'app.asar',
      'node_modules',
      '@worklouder',
      'device-kit-oai',
    );
    if (fs.existsSync(path.join(packageDir, 'package.json'))) {
      return { entry: packageDir, source: 'openai-app' };
    }
  }
  return null;
}

function forkWorkLouderHost(_sdkEntry: string): ReturnType<typeof utilityProcess.fork> {
  return utilityProcess.fork(path.join(__dirname, 'workLouderCodexHostProcess.js'), [], {
    serviceName: 'cindy-worklouder-codex',
  });
}

const hostClient = new WorkLouderCodexHostClient({
  resolveSdk: resolveWorkLouderSdk,
  fork: forkWorkLouderHost,
  log,
});

export const workLouderCodexLightingController = new WorkLouderCodexLightingController(
  hostClient,
  (sessionId) => {
    focusMainWindow();
    openMainWindowSession(sessionId);
  },
);
