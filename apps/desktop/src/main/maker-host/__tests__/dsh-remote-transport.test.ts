import { describe, expect, it, vi } from 'vitest';

import type { RemoteHost } from '@cindy/maker-remote-ssh';
import { createSshDshTransport } from '../dsh-remote-transport.js';

function makeChannel() {
  let stdout: ((chunk: Buffer) => void) | undefined;
  let stderr: ((chunk: string) => void) | undefined;
  let closed: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const writes: string[] = [];
  return {
    writes,
    write: vi.fn((value: string) => { writes.push(value); return true; }),
    end: vi.fn(), kill: vi.fn(),
    onStdout: vi.fn(() => () => undefined),
    onStdoutBytes: vi.fn((handler) => { stdout = handler; return () => undefined; }),
    onStderr: vi.fn((handler) => { stderr = handler; return () => undefined; }),
    onDrain: vi.fn(() => () => undefined),
    onClose: vi.fn((handler) => { closed = handler; return () => undefined; }),
    onError: vi.fn(() => () => undefined),
    emitStdout: (value: string) => stdout?.(Buffer.from(value)),
    emitStderr: (value: string) => stderr?.(value),
    emitClose: () => closed?.({ code: 0, signal: null }),
  };
}

const logger = { warn: vi.fn(), child: vi.fn(function child() { return logger; }) };

describe('createSshDshTransport', () => {
  it('sends a private launch envelope before JSONL and forwards complete lines', async () => {
    const channel = makeChannel();
    const execStream = vi.fn<(command: string, opts?: unknown) => Promise<typeof channel>>(async () => channel);
    const transport = await createSshDshTransport({
      remoteHost: { id: 'host-1', execStream } as unknown as RemoteHost,
      workingDir: '/repo', configYaml: 'config: true\n', bridgeSource: 'export {};\n',
      apiKey: 'not-logged-key', sessionRoot: '$HOME/.xdt-server/v1/dsh-sessions', logger,
    });
    expect(execStream.mock.calls[0][0]).toContain('packaged-bin.js');
    expect(channel.writes).toHaveLength(5);
    expect(channel.writes.join('')).not.toContain('not-logged-key');
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));
    channel.emitStdout('{"id":1'); channel.emitStdout('}\n');
    expect(lines).toEqual(['{"id":1}']);
    await transport.writeLine('{"method":"ping"}');
    expect(channel.writes.at(-1)).toBe('{"method":"ping"}\n');
  });
});
