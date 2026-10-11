import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');

// Exercise the complete probe with an in-memory window and filesystem. The
// baseline is healthy; each fault is injected only after the window recovers.
async function probe(fault) {
  let captures = 0;
  let clicks = 0;
  let inputEvents = 0;
  let lostFocus = false;
  let wokenByFrame = false;
  let report;
  let complete;
  const done = new Promise((resolve) => {
    complete = resolve;
  });
  const contents = {
    id: 1,
    getOSProcessId: () => 2,
    getBackgroundThrottling: () => false,
    setBackgroundThrottling() {},
    on() {},
    focus() {},
    setWindowOpenHandler() {},
    async loadFile() {},
    async executeJavaScript(script) {
      if (script.includes('probeFrame') && clicks === 1) wokenByFrame = true;
      return script.includes('probeFrame') ? { arrived: true } : { clicks };
    },
    async capturePage() {
      captures++;
      if (captures === 2 && fault === 'capture') throw new Error('capture rejected');
      if (captures === 2 && fault === 'timeout') return new Promise(() => {});
      return {
        toPNG: () => Buffer.alloc(1),
        resize() {
          return this;
        },
        toBitmap() {
          if (captures === 2 && fault === 'conversion') throw new Error('conversion failed');
          return Buffer.alloc(1);
        },
      };
    },
    sendInputEvent(event) {
      inputEvents++;
      if (captures === 2 && fault === 'focus-during-input') lostFocus = true;
      if (event.type === 'mouseUp' && !(captures === 2 && fault === 'input')) clicks++;
    },
  };
  class Window {
    webContents = contents;
    visible = false;
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    isFocused() {
      return !lostFocus && !(captures === 2 && ['focus', 'pixels-unfocused'].includes(fault));
    }
    isDestroyed() {
      return false;
    }
    on() {}
    focus() {}
    destroy() {}
  }
  const dependencies = {
    electron: {
      app: {
        setPath() {},
        on() {},
        whenReady: () => Promise.resolve(),
        getGPUFeatureStatus: () => ({}),
        exit: (code) => complete({ code, report, inputEvents }),
      },
      BrowserWindow: Window,
    },
    'node:fs': {
      mkdirSync() {},
      appendFileSync() {},
      writeFileSync(file, data) {
        if (file.endsWith('after-idle.png') && fault === 'write') throw new Error('write failed');
        if (file.endsWith('report.json')) report = JSON.parse(data);
      },
    },
    'node:timers/promises': {
      setTimeout: (ms) =>
        ms === 10_000 && !(captures === 2 && fault === 'timeout')
          ? new Promise(() => {})
          : Promise.resolve(),
    },
    './pixels.cjs': {
      inspectPixels: () => ({
        pixelsMatch: !(
          captures === 2 &&
          (['pixels', 'pixels-unfocused'].includes(fault) ||
            (fault === 'woken-by-frame' && !wokenByFrame))
        ),
      }),
    },
  };
  vm.runInNewContext(source, {
    require: (name) => dependencies[name] ?? require(name),
    __dirname: path.dirname(fileURLToPath(import.meta.url)),
    process: {
      env: {
        RENDER_PROBE_OUTPUT: 'memory-output',
        RENDER_PROBE_PROFILE: 'memory-profile',
        RENDER_PROBE_IDLE_SECONDS: '1',
        RENDER_PROBE_HIDDEN_SECONDS: '1',
        RENDER_PROBE_SCENARIO: 'hide',
        RENDER_PROBE_SURFACE: 'window',
      },
      versions: {},
      platform: 'win32',
      arch: 'x64',
      on() {},
    },
  });
  return done;
}

describe('render probe evidence classification', () => {
  it.each(['capture', 'timeout', 'conversion', 'write'])(
    'treats %s errors as inconclusive',
    async (fault) => {
      const { code, report } = await probe(fault);
      expect(code).toBe(2);
      expect(report.status).toBe('inconclusive');
      expect(report.error).toBeTruthy();
      expect(report.samples.at(-1).pixelsMatch).toBeUndefined();
    },
  );
  it('fails only when collected pixels mismatch', async () => {
    const { code, report } = await probe('pixels');
    expect(code).toBe(1);
    expect(report.samples.at(-1).pixelsMatch).toBe(false);
  });
  it('passes healthy evidence', async () => {
    expect((await probe()).report.status).toBe('passed');
  });
  it.each(['focus', 'focus-during-input'])(
    'treats %s as inconclusive instead of failed input',
    async (fault) => {
      const { code, report, inputEvents } = await probe(fault);
      expect(code).toBe(2);
      expect(report.status).toBe('inconclusive');
      expect(report.samples.at(-1)).toMatchObject({
        pixelsMatch: true,
        frame: { arrived: true },
        inputFocused: false,
        inputResponded: null,
      });
      expect(inputEvents).toBe(fault === 'focus' ? 2 : 4);
    },
  );
  it('preserves pixel failure even when input cannot be assessed without focus', async () => {
    const { code, report } = await probe('pixels-unfocused');
    expect(code).toBe(1);
    expect(report.samples.at(-1)).toMatchObject({ pixelsMatch: false, inputResponded: null });
  });
  it('still fails unresponsive input in a focused window', async () => {
    const { code, report } = await probe('input');
    expect(code).toBe(1);
    expect(report.samples.at(-1)).toMatchObject({ inputFocused: true, inputResponded: false });
  });
  it('preserves a bad restored frame even when the rAF probe wakes the compositor', async () => {
    const { code, report } = await probe('woken-by-frame');
    expect(code).toBe(1);
    expect(report.samples.at(-1)).toMatchObject({
      pixelsMatch: false,
      frame: { arrived: true },
      inputResponded: true,
    });
  });
});
