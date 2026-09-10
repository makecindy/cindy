import { randomUUID } from 'node:crypto';

/** Correlates an explicit reset with the trusted renderer's persisted-memory acknowledgement. */
export class ModelMemoryResetRequests {
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; isCurrent: () => boolean; timer: ReturnType<typeof setTimeout> }
  >();
  request(send: (requestId: string) => void, isCurrent = () => true): Promise<{ resetApplied: true }> {
    if (this.pending.size >= 100) return Promise.reject(new Error('MODEL_MEMORY_RESET_BUSY'));
    const id = randomUUID();
    return new Promise<{ resetApplied: true }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MODEL_MEMORY_RESET_NOT_CONFIRMED'));
      }, 5000);
      this.pending.set(id, { resolve: () => resolve({ resetApplied: true }), reject, timer, isCurrent });
      try {
        send(id);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  acknowledge(id: unknown): boolean {
    if (typeof id !== 'string') return false;
    const request = this.pending.get(id);
    if (!request) return false;
    clearTimeout(request.timer);
    this.pending.delete(id);
    if (!request.isCurrent()) { request.reject(new Error('MODEL_MEMORY_RESET_OWNER_CHANGED')); return false; }
    request.resolve();
    return true;
  }
}
