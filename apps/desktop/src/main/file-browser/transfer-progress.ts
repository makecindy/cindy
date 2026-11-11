export type FileTransferPhase = 'upload' | 'download' | 'pack' | 'extract';

export function fileTransferRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}

/** All file entry points share correlation and throttling. Phase/reset/final events never wait. */
export function createFileTransferProgressReporter(
  identity: { workdir: string; relPath: string; requestId?: unknown },
  publish: (event: {
    workdir: string;
    relPath: string;
    requestId?: string;
    received: number;
    total: number;
    phase: FileTransferPhase;
  }) => void,
) {
  const requestId = fileTransferRequestId(identity.requestId);
  let last: { time: number; received: number; phase: FileTransferPhase } | undefined;
  return (received: number, total: number, phase: FileTransferPhase = 'download') => {
    const now = Date.now();
    if (
      last &&
      last.phase === phase &&
      received >= last.received &&
      now - last.time < 100 &&
      (total <= 0 || received < total)
    )
      return;
    last = { time: now, received, phase };
    publish({
      workdir: identity.workdir,
      relPath: identity.relPath,
      requestId,
      received,
      total,
      phase,
    });
  };
}
