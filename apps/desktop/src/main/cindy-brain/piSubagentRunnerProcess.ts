import {runPiSubagentProcess} from '@cindy/app-runtime/piSubagentRunnerProcess';
runPiSubagentProcess((process as unknown as {parentPort?: {postMessage(message: unknown): void}}).parentPort);
