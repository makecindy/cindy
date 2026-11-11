import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 64 * 1024;
const FILE_BYTES_PER_POLL = 256 * 1024;
const MAX_LINE_CHARS = 64 * 1024;

/** A registration belongs to a live CC process, not to retained task history. */
interface Target {
  sessionId: string;
  references: number;
  offset: number;
  identity: string | null;
  pending: string;
  decoder: StringDecoder;
}

/** Reads a bounded, fair slice of explicitly registered files; false means retry the line. */
export class CcDebugRawTailer {
  private readonly targets = new Map<string, Target>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly writeLine: (line: string, sessionId: string) => boolean,
    private readonly bytesPerPoll = 1024 * 1024,
  ) {}

  register(file: string, sessionId: string): () => void {
    let target = this.targets.get(file);
    if (target) {
      target.references++;
    } else {
      target = { sessionId, references: 1, offset: 0, identity: null, pending: '', decoder: new StringDecoder('utf8') };
      // Capture EOF at registration, before the first poll; a not-yet-created
      // file starts at zero so its first diagnostics are not skipped.
      try {
        const stat = fs.statSync(file);
        target.offset = stat.size;
        target.identity = `${stat.dev}:${stat.ino}`;
      } catch { /* file will be created by CC */ }
      this.targets.set(file, target);
    }
    const registered = target;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--registered.references > 0) return;
      // One bounded final read. Any backlog remains in the original raw file,
      // never in an immortal in-memory queue after its writer has exited.
      if (this.timer) this.read(file, registered, CHUNK_BYTES);
      this.flush(registered, true);
      this.targets.delete(file);
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.timer) {
      this.timer = setInterval(() => this.pollNow(), 2_000);
      this.timer.unref?.();
    } else if (!enabled && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      for (const target of this.targets.values()) {
        target.pending = '';
        target.decoder = new StringDecoder('utf8');
      }
    }
  }

  pollNow(): void {
    let remaining = this.bytesPerPoll;
    // Rotate visited entries without copying the whole registry. The original
    // count prevents Map reinsertion from visiting an entry twice this round.
    const count = Math.min(this.targets.size, 64);
    const iterator = this.targets.entries();
    for (let i = 0; i < count && remaining > 0; i++) {
      const entry = iterator.next().value;
      if (!entry) break;
      const [file, target] = entry;
      this.targets.delete(file);
      this.targets.set(file, target);
      remaining -= this.read(file, target, Math.min(FILE_BYTES_PER_POLL, remaining));
      // Stat-only targets still consume a scheduling slot.
      remaining -= 1;
    }
  }

  private read(file: string, target: Target, budget: number): number {
    if (!this.flush(target)) return 0;
    let fd: number | undefined;
    let consumed = 0;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return 0;
      const identity = `${stat.dev}:${stat.ino}`;
      if ((target.identity !== null && target.identity !== identity) || stat.size < target.offset) {
        target.offset = 0;
        target.pending = '';
        target.decoder = new StringDecoder('utf8');
      }
      target.identity = identity;
      while (consumed < budget && target.offset < stat.size) {
        const wanted = Math.min(CHUNK_BYTES, budget - consumed, stat.size - target.offset);
        const buffer = Buffer.allocUnsafe(wanted);
        const bytes = fs.readSync(fd, buffer, 0, wanted, target.offset);
        if (bytes === 0) break;
        target.offset += bytes;
        consumed += bytes;
        target.pending += target.decoder.write(buffer.subarray(0, bytes));
        if (!this.flush(target)) break;
      }
      return consumed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        target.offset = 0;
        target.identity = null;
        target.pending = '';
        target.decoder = new StringDecoder('utf8');
      }
      return consumed;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  private flush(target: Target, final = false): boolean {
    while (target.pending.length > 0) {
      const newline = target.pending.indexOf('\n');
      const fragment = newline < 0 ? target.pending.length >= MAX_LINE_CHARS : newline > MAX_LINE_CHARS;
      if (newline < 0 && !fragment && !final) return true;
      let length = fragment ? MAX_LINE_CHARS : newline < 0 ? target.pending.length : newline;
      if (fragment && target.pending.charCodeAt(length - 1) >= 0xd800
        && target.pending.charCodeAt(length - 1) <= 0xdbff) length--;
      const line = target.pending.slice(0, length);
      if (line && !this.writeLine(fragment ? `${line} [cc-debug line continued]` : line, target.sessionId)) return false;
      target.pending = target.pending.slice(length + (!fragment && newline >= 0 ? 1 : 0));
    }
    return true;
  }
}
