import path from 'node:path';
import {utilityProcess} from 'electron';
import type {PiSubagentRunnerLaunchRequest} from '@cindy/maker-core';
import {spawnPiSubagentRunner as spawnOriginalRunner} from '@cindy/app-runtime/piSubagentRunnerHost';

export function spawnPiSubagentRunner(request: PiSubagentRunnerLaunchRequest, fork: typeof utilityProcess.fork = utilityProcess.fork) {
  return spawnOriginalRunner(request, fork, path.join(__dirname, 'piSubagentRunnerProcess.js'));
}
