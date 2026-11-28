import { describe, expect, it, vi } from 'vitest';
import { LinuxDesktopInput, type LinuxInputText } from '../linuxX11Input';

function fixture() {
  let activeWindow = '42';
  let current = true;
  const commands: string[][] = [];
  const texts: string[] = [];
  const command = vi.fn(async (args: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted();
    commands.push(args);
    if (args[0] === 'getactivewindow') return activeWindow;
    if (args[0] === 'getwindowpid') return '123';
    return '1280 800';
  });
  const insertText = vi.fn(async (request: LinuxInputText) => {
    await request.validate();
    texts.push(request.text);
  });
  const hold = vi.fn();
  const close = vi.fn(async () => {});
  const failure = vi.fn(() => {
    void input.stop();
  });
  const input = new LinuxDesktopInput(
    { current: async () => current, command, insertText, hold, close },
    failure,
  );
  return {
    input,
    command,
    commands,
    texts,
    insertText,
    hold,
    close,
    failure,
    focus: (window: string) => {
      activeWindow = window;
    },
    disconnect: () => {
      current = false;
    },
  };
}

describe('Linux desktop input', () => {
  it('batches native coordinates, button edges, shortcuts and scroll without a shell', async () => {
    const test = fixture();
    test.input.input([
      { kind: 'move', x: 20, y: 30 },
      { kind: 'button', x: 20, y: 30, button: 0, down: true },
      { kind: 'move', x: 100, y: 80 },
      { kind: 'button', x: 100, y: 80, button: 0, down: false },
      { kind: 'key', code: 'ControlLeft', down: true },
      { kind: 'key', code: 'KeyA', down: true },
      { kind: 'key', code: 'KeyA', down: false },
      { kind: 'key', code: 'ControlLeft', down: false },
      { kind: 'scroll', dx: -80, dy: 40 },
    ]);
    await test.input.settled();
    expect(test.commands).toEqual([
      [
        'mousemove',
        '20',
        '30',
        'mousemove',
        '20',
        '30',
        'mousedown',
        '1',
        'mousemove',
        '100',
        '80',
        'mousemove',
        '100',
        '80',
        'mouseup',
        '1',
        'keydown',
        'Control_L',
        'keydown',
        'a',
        'keyup',
        'a',
        'keyup',
        'Control_L',
        'click',
        '--repeat',
        '2',
        '--delay',
        '0',
        '6',
        'click',
        '--repeat',
        '1',
        '--delay',
        '0',
        '5',
      ],
    ]);
    expect(test.hold).toHaveBeenCalledWith(['Control_L', 'a'], [1]);
    expect(test.hold).toHaveBeenLastCalledWith([], []);
    await test.input.stop();
  });

  it.each(['A'.repeat(4096), '中'.repeat(4096), '中文Ab😀'.repeat(682) + '\n'])(
    'inserts long committed text as one operation',
    async (text) => {
      const test = fixture();
      test.input.input([{ kind: 'text', text }]);
      await test.input.settled();
      expect(test.texts).toEqual([text]);
      expect(test.insertText).toHaveBeenCalledOnce();
      expect(
        test.commands.every((command) => ['getactivewindow', 'getwindowpid'].includes(command[0])),
      ).toBe(true);
      expect(JSON.stringify(test.commands)).not.toContain(text);
      expect(test.failure).not.toHaveBeenCalled();
      await test.input.stop();
    },
  );

  it('preserves ordering around text and waits for cleanup before releasing its owner', async () => {
    const test = fixture();
    let finish!: () => void;
    test.insertText.mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await request.validate();
    });
    test.input.input([
      { kind: 'key', code: 'ControlLeft', down: true },
      { kind: 'text', text: 'secret' },
      { kind: 'move', x: 12, y: 23 },
    ]);
    await vi.waitFor(() => expect(test.insertText).toHaveBeenCalledOnce());
    const stopped = test.input.stop();
    expect(test.close).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(test.commands).toContainEqual(['keyup', 'Control_L']);
    expect(test.commands).not.toContainEqual(['mousemove', '12', '23']);
    expect(test.failure).not.toHaveBeenCalled();
    expect(test.close).toHaveBeenCalledOnce();
  });

  it('does not retarget or retry text after the focused window changes', async () => {
    const test = fixture();
    test.insertText.mockImplementation(async (request) => {
      test.focus('99');
      await request.validate();
    });
    test.input.input([
      { kind: 'text', text: 'private' },
      { kind: 'move', x: 3, y: 4 },
    ]);
    await test.input.settled();
    await test.input.stop();
    expect(test.insertText).toHaveBeenCalledOnce();
    expect(test.failure).toHaveBeenCalledOnce();
    expect(test.commands).not.toContainEqual(['mousemove', '3', '4']);
  });

  it('never sends a release or replays queued input into a replacement Xvfb', async () => {
    const test = fixture();
    test.input.input([{ kind: 'button', x: 1, y: 2, button: 2, down: true }]);
    await test.input.settled();
    const before = test.commands.length;
    test.disconnect();
    test.input.input([]);
    await test.input.settled();
    await test.input.stop();
    expect(test.commands).toHaveLength(before);
    expect(test.failure).toHaveBeenCalledOnce();
    expect(test.close).toHaveBeenCalledOnce();
    expect(() => test.input.input([{ kind: 'move', x: 1, y: 2 }])).toThrow('EXPIRED');
  });

  it('releases possibly dispatched edges after a native command fails', async () => {
    const test = fixture();
    test.command.mockRejectedValueOnce(new Error('untrusted stdout'));
    test.input.input([
      { kind: 'key', code: 'ShiftLeft', down: true },
      { kind: 'key', code: 'ShiftLeft', down: false },
    ]);
    await test.input.settled();
    await test.input.stop();
    expect(test.commands).toContainEqual(['keyup', 'Shift_L']);
    expect(test.failure).toHaveBeenCalledOnce();
  });

  it.each(['\ud83d', '\ude00', '\u0000', 'x'.repeat(4097)])(
    'rejects invalid committed text without partial delivery',
    async (text) => {
      const test = fixture();
      test.input.input([{ kind: 'text', text }]);
      await test.input.settled();
      await test.input.stop();
      expect(test.insertText).not.toHaveBeenCalled();
      expect(test.failure).toHaveBeenCalledOnce();
    },
  );

  it('rejects control characters but preserves committed tabs and newlines', async () => {
    for (const point of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const test = fixture();
      const text = `before${String.fromCharCode(point)}after`;
      test.input.input([{ kind: 'text', text }]);
      await test.input.settled();
      await test.input.stop();
      if (point === 9 || point === 10) {
        expect(test.texts).toEqual([text]);
        expect(test.failure).not.toHaveBeenCalled();
      } else {
        expect(test.insertText).not.toHaveBeenCalled();
        expect(test.failure).toHaveBeenCalledOnce();
      }
    }
  });

  it('bounds queued text while a delivery is in flight', async () => {
    const test = fixture();
    test.input.input(
      Array.from({ length: 3 }, () => ({ kind: 'text' as const, text: '中'.repeat(4096) })),
    );
    await test.input.stop();
    expect(test.failure).toHaveBeenCalledOnce();
    expect(test.insertText).not.toHaveBeenCalled();
  });
});
