import { extractIpcError } from '@/utils/ipcError';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import {
  isWritableDirectoryGrantErrorCode,
  type WritableDirectoryGrantErrorCode,
} from '../../../shared/writableDirectoryGrantError';

export interface DraftDirectoryRecoveryContext {
  scopeId: string;
  ownerId: string | null;
  ownerGeneration: number;
  workingDir: string | null;
  writableDirs: readonly string[];
  remoteHostId: string | null;
  deviceLinkDeviceId: string | null;
  agentDeviceId: string | null;
}

export interface DraftDirectoryRecoveryState {
  context: DraftDirectoryRecoveryContext;
  code: WritableDirectoryGrantErrorCode;
  phase: 'required' | 'selecting' | 'cancelled' | 'mismatch' | 'failed' | 'ready';
  index: number;
}

type Picker = (options: { defaultPath: string; writableGrantScope: string }) => Promise<{
  success: boolean;
  path: string | null;
}>;

function contextKey(context: DraftDirectoryRecoveryContext): string {
  return JSON.stringify(context);
}

/**
 * Restore picker evidence for the unchanged draft, never create or send a task.
 * Every await rechecks the owner/directory domain; stale native dialogs cannot
 * update a different draft. Main remains responsible for all permission checks.
 */
export class DraftDirectoryRecovery {
  private state: DraftDirectoryRecoveryState | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly currentContext: () => DraftDirectoryRecoveryContext | null,
    private readonly pick: Picker,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): DraftDirectoryRecoveryState | null => this.state;

  captureContext = (): DraftDirectoryRecoveryContext | null => {
    const context = this.currentContext();
    return context ? { ...context, writableDirs: [...context.writableDirs] } : null;
  };

  isCurrent = (context: DraftDirectoryRecoveryContext): boolean => {
    const current = this.currentContext();
    return current !== null && contextKey(current) === contextKey(context);
  };

  isSelecting = (): boolean => this.state?.phase === 'selecting' && this.isCurrent(this.state.context);

  capture = (error: unknown, context: DraftDirectoryRecoveryContext | null): boolean => {
    const code = extractIpcError(error)?.code;
    if (!isWritableDirectoryGrantErrorCode(code) || !context || !this.isCurrent(context)
      || context.remoteHostId || context.deviceLinkDeviceId || context.writableDirs.length === 0) {
      return false;
    }
    this.epoch += 1;
    this.publish({ context, code, phase: 'required', index: 0 });
    return true;
  };

  clear = (): void => {
    this.epoch += 1;
    this.publish(null);
  };

  reselect = async (): Promise<void> => {
    const request = this.state;
    if (!request || this.isSelecting() || !this.isCurrent(request.context)) return;
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch && this.isCurrent(request.context);
    try {
      for (let index = 0; index < request.context.writableDirs.length; index += 1) {
        if (!isCurrent()) return;
        this.publish({ ...request, phase: 'selecting', index });
        const directory = request.context.writableDirs[index];
        const result = await this.pick({
          defaultPath: directory,
          writableGrantScope: request.context.scopeId,
        });
        if (!isCurrent()) return;
        if (!result.success || !result.path) {
          this.publish({ ...request, phase: 'cancelled', index });
          return;
        }
        // Do not broaden this to grouping/realpath/case-insensitive equality.
        // The actual selected path must be the original requested grant path.
        if (normalizeWorkingDirForStorage(result.path) !== normalizeWorkingDirForStorage(directory)) {
          this.publish({ ...request, phase: 'mismatch', index });
          return;
        }
      }
      if (isCurrent()) this.publish({ ...request, phase: 'ready', index: request.context.writableDirs.length });
    } catch {
      if (isCurrent()) this.publish({ ...request, phase: 'failed' });
    }
  };

  private publish(state: DraftDirectoryRecoveryState | null): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
