import { throwIpcError } from '../utils/ipcValidate';
/** The input coordinator owns reservations, including cancellation and restart recovery. */
type Reader = (sessionId: string) => Promise<ReadonlySet<string>>;
let reader: Reader | undefined;
export function setMessageAnnotationQueueReader(next: Reader): void { reader = next; }
export async function readQueuedMessageAnnotationIds(sessionId: string): Promise<ReadonlySet<string>> {
  if (!reader) throwIpcError('PRECONDITION_FAILED', 'Input queue is not ready');
  return reader(sessionId);
}
