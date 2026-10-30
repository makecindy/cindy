import { EventEmitter } from 'node:events';
import matter from 'gray-matter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomizationScanClient, type CustomizationScanChild } from '../customizationScanClient';
import type { CustomizationScanRequest } from '../customizationScanProtocol';

class FakeScanner extends EventEmitter implements CustomizationScanChild {
  postMessage = vi.fn<(message: CustomizationScanRequest) => void>();
  autoExit = true;
  kill = vi.fn(() => {
    if (this.autoExit) queueMicrotask(() => this.emit('exit', 0));
    return true;
  });

  reply(result = { items: [], errors: [] }): void {
    const request = this.postMessage.mock.calls.at(-1)![0];
    this.emit('message', { kind: 'result', id: request.id, result });
  }
}

afterEach(() => vi.useRealTimers());

describe('bounded customization discovery', () => {
  it('accepts cyclic YAML metadata in list projection requests', async () => {
    const child = new FakeScanner();
    const client = new CustomizationScanClient({ fork: () => child });
    const expected = { skills: [], sources: [] };
    child.postMessage.mockImplementation((request) => {
      const packet = structuredClone(request);
      queueMicrotask(() => child.emit('message', { kind: 'result', id: packet.id, result: expected }));
    });
    const frontmatter = matter('---\na: &a { b: *a }\n---\nskill').data;
    const input = { projects: [], listed: { items: [{ engine: 'pi' as const, kind: 'skill', scope: 'user',
      name: 'cyclic', absolutePath: '/tmp/.agents/skills/cyclic', frontmatter }], errors: [] },
      registryEntries: [], managedSkillRoots: [], builtInSkills: [], disabledPaths: [],
      userDataDir: '/tmp/profile', appDataDir: '/tmp/appdata' };
    await expect(client.request({ kind: 'project', input },
      (value): value is typeof expected => value !== null && typeof value === 'object',
      () => expected)).resolves.toEqual(expected);
    expect(child.postMessage).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('returns an error and kills an unresponsive scanner while Main timers still run', async () => {
    vi.useFakeTimers();
    const child = new FakeScanner();
    const client = new CustomizationScanClient({ fork: () => child, timeoutMs: 100 });
    const scan = client.scan('pi', { workingDirs: ['/project'] });
    const heartbeat = vi.fn();
    setTimeout(heartbeat, 10);

    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    expect(await scan).toEqual({
      items: [], errors: [{ message: '[pi] Customization scan timed out' }],
    });
    expect(child.kill).toHaveBeenCalledOnce();

    // A hung/failed run must not poison the next refresh.
    const refresh = client.scan('pi', { workingDirs: ['/project'] });
    child.reply();
    expect(await refresh).toEqual({ items: [], errors: [] });
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate scans but gives each caller its own mutable result', async () => {
    const child = new FakeScanner();
    const fork = vi.fn(() => child);
    const client = new CustomizationScanClient({ fork });
    const options = { workingDirs: ['/project'], kinds: ['skill'] };
    const first = client.scan('claude-code', options);
    const second = client.scan('claude-code', options);
    expect(fork).toHaveBeenCalledOnce();
    expect(child.postMessage.mock.calls[0][0]).toMatchObject({
      kind: 'scan', engine: 'claude-code', options,
    });
    child.reply();
    const a = await first;
    const b = await second;
    a.errors.push({ message: 'Caller-local managed skill failure' });
    expect(b.errors).toEqual([]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('isolates failures between engines and ignores late responses from a timed-out child', async () => {
    vi.useFakeTimers();
    const children: FakeScanner[] = [];
    const client = new CustomizationScanClient({
      fork: () => { const child = new FakeScanner(); children.push(child); return child; },
      timeoutMs: 100,
    });
    const pi = client.scan('pi', {});
    const codex = client.scan('codex', {});
    children[1].reply();
    expect(await codex).toEqual({ items: [], errors: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pi).errors[0].message).toContain('timed out');
    const refresh = client.scan('pi', {});
    children[0].reply();
    children[2].reply();
    expect(await refresh).toEqual({ items: [], errors: [] });
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it.each(['exit', 'error', 'postMessage', 'fork', 'invalid result'])(
    'settles and cleans up when the scanner fails at %s', async (failure) => {
      const child = new FakeScanner();
      const client = new CustomizationScanClient({
        fork: () => {
          if (failure === 'fork') throw new Error('cannot start');
          return child;
        },
      });
      if (failure === 'postMessage') child.postMessage.mockImplementation(() => { throw new Error('closed'); });
      const scan = client.scan('codex', {});
      if (failure === 'exit') child.emit('exit', 1);
      if (failure === 'error') child.emit('error', 'crashed');
      if (failure === 'invalid result') {
        child.emit('message', { kind: 'result', id: child.postMessage.mock.calls[0][0].id, result: null });
      }
      expect((await scan).errors).toHaveLength(1);
      expect(child.kill).toHaveBeenCalledTimes(failure === 'fork' || failure === 'exit' ? 0 : 1);
      client.dispose();
      expect(child.kill).toHaveBeenCalledTimes(failure === 'fork' || failure === 'exit' ? 0 : 1);
    },
  );

  it('retains terminating children in the limit until exit, even when kill fails', async () => {
    vi.useFakeTimers();
    const children: FakeScanner[] = [];
    const client = new CustomizationScanClient({
      maxConcurrent: 2, timeoutMs: 100,
      fork: () => { const child = new FakeScanner(); child.autoExit = false; children.push(child); return child; },
    });
    const first = client.scan('pi', {});
    const second = client.scan('codex', {});
    children[1].kill.mockImplementation(() => false);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).errors[0].message).toContain('timed out');
    expect((await second).errors[0].message).toContain('timed out');
    for (let i = 0; i < 10; i++) expect((await client.scan('pi', {})).errors[0].message).toContain('busy');
    expect(children).toHaveLength(2);
    children[0].emit('exit', 0);
    const refreshed = client.scan('pi', {});
    expect(children).toHaveLength(3);
    children[2].reply();
    expect((await refreshed).errors).toEqual([]);
    expect((await client.scan('pi', {})).errors[0].message).toContain('busy');
    children[2].emit('exit', 0);
    client.dispose();
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it('bounds concurrent children and cancels pending work on shutdown', async () => {
    const child = new FakeScanner();
    const fork = vi.fn(() => child);
    const client = new CustomizationScanClient({ fork, maxConcurrent: 1 });
    const scan = client.scan('pi', {});
    const overflow = await client.scan('pi', { workingDirs: ['/other'] });
    expect(overflow.errors[0].message).toContain('busy');
    expect(fork).toHaveBeenCalledOnce();
    client.dispose();
    expect((await scan).errors[0].message).toContain('stopped');
    expect(child.kill).toHaveBeenCalledOnce();
    expect((await client.scan('pi', {})).errors).toHaveLength(1);
    expect(fork).toHaveBeenCalledOnce();
  });
});
