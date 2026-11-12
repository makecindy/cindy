import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { linuxClipboardVersion } from './linuxClipboard';

type Pending = {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type Session = {
  child?: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<number, Pending>;
  buffer: string;
  idle?: ReturnType<typeof setTimeout>;
};
const unavailable = () => new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');

/** Counter-only pipe, owned by a viewer/host. No content cache or automatic replay. */
export class ClipboardCounter {
  private session: Session | undefined;
  private sequence = 0;
  constructor(
    private readonly binary: () => Promise<string>,
    private readonly launch = (binary: string) =>
      spawn(binary, ['--clipboard-counter'], { stdio: 'pipe', windowsHide: true }),
  ) {}

  stop(): void {
    if (this.session) this.retire(this.session);
  }
  private retire(session: Session): void {
    if (this.session === session) this.session = undefined;
    clearTimeout(session.idle);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(unavailable());
    }
    session.pending.clear();
    // Immediate termination also bounds a helper stuck in an OS API. Its exit
    // handler owns only this session and cannot retire a replacement process.
    session.child?.stdin.destroy();
    session.child?.kill('SIGKILL');
  }
  private idle(session: Session): void {
    clearTimeout(session.idle);
    if (!session.pending.size && this.session === session)
      session.idle = setTimeout(() => this.retire(session), 4000);
  }
  private start(): Session {
    const session: Session = { ready: Promise.resolve(), pending: new Map(), buffer: '' };
    this.session = session;
    session.ready = this.binary().then((binary) => {
      if (this.session !== session) throw unavailable();
      const child = this.launch(binary);
      session.child = child;
      child.stderr.resume();
      child.once('error', () => this.retire(session));
      child.once('exit', () => this.retire(session));
      child.stdin.on('error', () => this.retire(session));
      child.stdout.on('error', () => this.retire(session));
      child.stderr.on('error', () => this.retire(session));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.session !== session) return;
        session.buffer += chunk;
        if (session.buffer.length > 4096) return this.retire(session);
        let end: number;
        while ((end = session.buffer.indexOf('\n')) !== -1) {
          const line = session.buffer.slice(0, end);
          session.buffer = session.buffer.slice(end + 1);
          const match = /^(\d{1,16}) (\d{1,128}|unavailable|unsupported)$/.exec(line);
          if (!match) return this.retire(session);
          const id = Number(match[1]);
          const pending = session.pending.get(id);
          if (!pending) return this.retire(session);
          session.pending.delete(id);
          clearTimeout(pending.timer);
          if (match[2] === 'unsupported') pending.reject(new Error('CLIPBOARD_UNSUPPORTED'));
          else if (match[2] === 'unavailable') pending.reject(unavailable());
          else pending.resolve(match[2]);
        }
        this.idle(session);
      });
    });
    // Each read handles the same startup failure; no background retry or spawn.
    return session;
  }
  async read(portable = false): Promise<string> {
    // Linux owns its Wayland selection adapter; its input helper does not
    // implement the macOS/Windows counter-only pipe.
    if (process.platform === 'linux') return linuxClipboardVersion();
    const session = this.session ?? this.start();
    if (session.pending.size >= 32) throw unavailable();
    clearTimeout(session.idle);
    const id = ++this.sequence;
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.retire(session), 125_000),
      };
      session.pending.set(id, pending);
      void session.ready
        .then(() => {
          if (this.session !== session || !session.pending.has(id)) throw unavailable();
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => this.retire(session), 2000);
          session.child!.stdin.write(`${id} ${portable ? 1 : 0}\n`, (error) => {
            if (error) this.retire(session);
          });
        })
        .catch(() => this.retire(session));
    });
  }
}
