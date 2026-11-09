import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadRunner } = vi.hoisted(() => ({ loadRunner: vi.fn() }));
vi.mock('node:module', () => ({ createRequire: () => loadRunner }));

const argv = process.argv;
const portDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

afterEach(() => {
  process.argv = argv;
  if (portDescriptor) Object.defineProperty(process, 'parentPort', portDescriptor);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.clearAllMocks();
});

function prepare() {
  const dir = path.join(path.sep, 'fixture', 'run');
  process.argv = [process.execPath, 'fixed-entry.js', path.join(dir, 'runner.cjs'), path.join(dir, 'config.json')];
  const postMessage = vi.fn();
  Object.defineProperty(process, 'parentPort', { configurable: true, value: { postMessage } });
  return { dir, postMessage };
}

describe('fixed Pi Subagent utility-process entry', () => {
  it('injects the real shared HY4 projection before starting the staged runner', async () => {
    // reset-modules: a fresh utility process evaluates argv and parentPort once.
    vi.resetModules();
    const { dir, postMessage } = prepare();
    const run = vi.fn();
    loadRunner.mockReturnValue(run);
    await import('../piSubagentRunnerProcess.js');
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(loadRunner).toHaveBeenCalledWith(path.join(dir, 'runner.cjs'));
    expect(process.argv.slice(1)).toEqual([path.join(dir, 'runner.cjs'), path.join(dir, 'config.json')]);
    expect(run).toHaveBeenCalledTimes(1);
    const project = run.mock.calls[0][0];
    expect(project('hy4', [{ type: 'text', text: 'private</think:6124c78e>answer' }])).toEqual([
      { type: 'thinking', thinking: 'private' }, { type: 'text', text: 'answer' },
    ]);
  });

  it('continues to load self-starting legacy snapshots', async () => {
    // reset-modules: load a legacy snapshot through a new utility-process startup.
    vi.resetModules();
    prepare();
    loadRunner.mockReturnValue({});
    await expect(import('../piSubagentRunnerProcess.js')).resolves.toBeDefined();
    expect(loadRunner).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid staged paths before loading or starting any runner', async () => {
    // reset-modules: invalid argv must be checked on a new process startup.
    vi.resetModules();
    const { postMessage } = prepare();
    process.argv[2] = 'relative-runner.cjs';
    await expect(import('../piSubagentRunnerProcess.js')).rejects.toThrow('arguments are invalid');
    expect(loadRunner).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
