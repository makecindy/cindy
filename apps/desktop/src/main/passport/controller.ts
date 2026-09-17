import { encodeSnapshot, parseHelperLine, type PassportTask, type PassportAction } from './protocol.js';

/** A single in-flight snapshot, with only the newest unsent state retained. */
export class PassportController {
  connectionVersion = 0;
  private ready = false;
  private busy = false;
  private latest: readonly PassportTask[] = [];
  private previous: Buffer | null = null;
  get isReady(): boolean { return this.ready; }
  constructor(private readonly write: (line: string) => void, private readonly open: (id: string) => void,
    private readonly action?: (action: PassportAction) => void) {}
  update(tasks: readonly PassportTask[]): void { this.latest = tasks; this.flush(); }
  handle(line: string): void {
    const event = parseHelperLine(line);
    if (!event) return;
    if (event.kind === 'disconnected') { this.reset(); return; }
    if (event.kind === 'ready') { this.connectionVersion++; this.ready = true; this.busy = false; this.previous = null; }
    if (event.kind === 'idle') this.busy = false;
    if (event.kind === 'open') {
      if (this.canOpen(event.id)) this.open(event.id);
      return;
    }
    if (event.kind === 'action') {
      if (this.canOpen(event.id)) this.action?.(event);
      return;
    }
    this.flush();
  }
  heartbeat(): void { this.previous = null; this.flush(); }
  canOpen(id: string): boolean { return this.ready && this.latest.some((task) => task.id === id); }
  reset(): void { this.connectionVersion++; this.ready = false; this.busy = false; this.previous = null; }
  private flush(): void {
    if (!this.ready || this.busy) return;
    const next = encodeSnapshot(this.latest);
    if (this.previous?.equals(next)) return;
    this.busy = true; this.previous = next;
    this.write(next.toString('base64') + '\n');
  }
}
