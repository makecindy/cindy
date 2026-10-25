import {runPiSubagentProcess} from '@cindy/app-runtime/piSubagentRunnerProcess';

runPiSubagentProcess(process.send ? {
  postMessage(message) {
    process.send!(message as Parameters<NonNullable<typeof process.send>>[0], () => {
      if (process.connected) process.disconnect();
    });
  },
} : undefined);
