import { createLogger } from '../logger.js';

import { createExecFileDiagnostics } from '@cindy/worktree-core/execFileDiagnostics';
const service = createExecFileDiagnostics(createLogger('exec-file-diagnostic'));
export const { beginExecFileDiagnostic, execFileWithDiagnostics } = service;
export type {
  ExecFileDiagnosticSource,
  ExecFileDiagnosticSpan,
  DiagnosticExecFile,
  ExecFileWithDiagnosticsOptions,
} from '@cindy/worktree-core/execFileDiagnostics';
