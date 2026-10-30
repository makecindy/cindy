import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('Windows diagnostics tray lifetime', () => {
  it.each(['quit', 'tray'])(
    'keeps diagnostics available after choosing close behavior %s',
    async (behavior) => {
      const start = bootstrap.indexOf(
        '  ipcMain.handle(\n    WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,',
      );
      const end = bootstrap.indexOf(
        '  ipcMain.on(WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL,',
        start,
      );
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const compiled = transpileModule(bootstrap.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      let handler!: (event: unknown, value: unknown) => Promise<unknown>;
      const destroyWindowsTray = vi.fn();
      const writeWindowsCloseBehavior = vi.fn();
      const acknowledge = vi.fn();
      const deps = {
        ipcMain: {
          handle: (_channel: string, callback: typeof handler) => {
            handler = callback;
          },
        },
        WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL: 'set-close-behavior',
        isWindowsCloseBehavior: (value: unknown) => value === 'quit' || value === 'tray',
        throwIpcError: () => {
          throw new Error('invalid behavior');
        },
        windowsClosePromptFallback: { acknowledge },
        writeWindowsCloseBehavior,
        destroyWindowsTray,
      };
      new Function(...Object.keys(deps), compiled)(...Object.values(deps));
      await expect(handler({}, behavior)).resolves.toBe(behavior);
      expect(writeWindowsCloseBehavior).toHaveBeenCalledWith(behavior);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(destroyWindowsTray).not.toHaveBeenCalled();
      await expect(handler({}, 'invalid')).rejects.toThrow('invalid behavior');
      expect(writeWindowsCloseBehavior).toHaveBeenCalledOnce();
    },
  );
});
