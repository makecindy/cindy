import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_READ_BYTES_PER_POLL = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_PARTIAL_LINE_CHARS = 256 * 1024;

interface TailState {
  offset: number;
  leftover: string;
  decoder: StringDecoder;
  identity: string;
}

interface TailTarget {
  filePath: string;
  sessionId: string;
}

export interface CcDebugRawTailerOptions {
  pollIntervalMs?: number;
  maxReadBytesPerPoll?: number;
}

/**
 * Tails only raw files explicitly registered by active debug sessions.
 *
 * Historical session directories are deliberately absent from this class:
 * walking every retained session every two seconds kept the Electron main
 * thread busy even when network debugging was disabled.
 */
export class CcDebugRawTailer {
  private readonly targets = new Map<string, TailTarget>();
  private readonly states = new Map<string, TailState>();
  private readonly pollIntervalMs: number;
  private readonly maxReadBytesPerPoll: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly writeLine: (line: string, sessionId: string) => void,
    options: CcDebugRawTailerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxReadBytesPerPoll = options.maxReadBytesPerPoll ?? DEFAULT_MAX_READ_BYTES_PER_POLL;
  }

  register(filePath: string, sessionId: string): void {
    this.targets.set(filePath, { filePath, sessionId });
  }

  start(globalFallbackFile: string): void {
    this.register(globalFallbackFile, '');
    if (this.timer) return;
    this.pollNow();
    this.timer = setInterval(() => this.pollNow(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets.clear();
    this.states.clear();
  }

  pollNow(): void {
    for (const target of this.targets.values()) {
      this.tailOne(target);
    }
  }

  private tailOne({ filePath, sessionId }: TailTarget): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    let state = this.states.get(filePath);
    if (!state) {
      // First observation starts at EOF so an app restart never replays old raw
      // diagnostics into the final NDJSON stream.
      this.states.set(filePath, {
        offset: stat.size,
        leftover: '',
        decoder: new StringDecoder('utf8'),
        identity,
      });
      return;
    }
    if (state.identity !== identity || stat.size < state.offset) {
      state = {
        offset: 0,
        leftover: '',
        decoder: new StringDecoder('utf8'),
        identity,
      };
      this.states.set(filePath, state);
    }
    if (stat.size === state.offset) return;

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return;
    }
    try {
      let remaining = Math.min(stat.size - state.offset, this.maxReadBytesPerPoll);
      while (remaining > 0) {
        const wanted = Math.min(READ_CHUNK_BYTES, remaining);
        const buffer = Buffer.allocUnsafe(wanted);
        const bytesRead = fs.readSync(fd, buffer, 0, wanted, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        remaining -= bytesRead;
        this.consumeText(state, state.decoder.write(buffer.subarray(0, bytesRead)), sessionId);
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  private consumeText(state: TailState, chunk: string, sessionId: string): void {
    state.leftover += chunk;
    const lines = state.leftover.split('\n');
    state.leftover = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length > 0) this.writeLine(line, sessionId);
    }
    while (state.leftover.length > MAX_PARTIAL_LINE_CHARS) {
      const fragment = state.leftover.slice(0, MAX_PARTIAL_LINE_CHARS);
      state.leftover = state.leftover.slice(MAX_PARTIAL_LINE_CHARS);
      this.writeLine(`${fragment} [cc-debug line continued]`, sessionId);
    }
  }
}
