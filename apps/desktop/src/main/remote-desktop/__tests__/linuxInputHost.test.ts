import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openLinuxDesktopInput } from '../linuxInputHost';
import {
  HumanDesktopInput,
  isHumanDesktopInputActive,
  withAgentDesktopInput,
} from '../inputOwnership';

const fixture = vi.hoisted(() => ({
  insertText: vi.fn(async () => {}),
  command: vi.fn(async (args: string[]) =>
    args[0] === 'getactivewindow' ? '42' : String(process.pid),
  ),
}));
vi.mock('electron', () => ({
  screen: { getAllDisplays: () => [{ id: '1', bounds: { x: 0, y: 0, width: 1280, height: 800 } }] },
}));
vi.mock('../linuxDisplay', () => ({
  openLinuxDisplay: async () => ({
    width: 1280,
    height: 800,
    current: async () => true,
    environment: {},
  }),
}));
vi.mock('../linuxInputGuard', () => ({
  openLinuxInputGuard: async () => ({ command: fixture.command, insertText: fixture.insertText }),
}));

beforeEach(() => vi.clearAllMocks());

describe('Linux native text and shared input ownership', () => {
  it.each([process.pid, process.pid + 1])(
    'uses native input for both Cindy and external windows (%i)',
    async (pid) => {
      fixture.command.mockImplementation(async (args) =>
        args[0] === 'getactivewindow' ? '42' : String(pid),
      );
      const input = await openLinuxDesktopInput('1', vi.fn());
      input.input([{ kind: 'text', text: '中文😀' }]);
      await input.settled();
      expect(fixture.insertText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          pid,
          windowId: 42,
          text: '中文😀',
          signal: expect.any(AbortSignal),
        }),
      );
      await input.stop();
    },
  );

  it('excludes Agent actions while actual remote input is pending', async () => {
    const human = new HumanDesktopInput();
    const batch = human.begin([{ kind: 'text', text: 'hello' }]);
    try {
      await batch.ready;
      await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('Remote desktop input');
    } finally {
      batch.complete();
      human.release();
    }
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });

  it('waits for asynchronous Agent cleanup before delivering human input', async () => {
    let release!: () => void;
    const action = withAgentDesktopInput(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const human = new HumanDesktopInput();
    const batch = human.begin([{ kind: 'text', text: 'hello' }]);
    const delivered = vi.fn();
    void batch.ready.then(delivered);
    expect(isHumanDesktopInputActive()).toBe(true);
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    release();
    await action;
    await batch.ready;
    expect(delivered).toHaveBeenCalledOnce();
    batch.complete();
    batch.complete();
    human.release();
    human.release();
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });
});
