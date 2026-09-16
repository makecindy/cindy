import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { rollup as esmRollup } from 'rollup';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { rollup: cjsRollup } = require('rollup') as typeof import('rollup');

describe.each([
  ['ESM', esmRollup],
  ['CommonJS', cjsRollup],
] as const)('Rollup %s external namespace interop', (_name, rollup) => {
  it('loads ws with inherited EventEmitter statics and preserves live exports', async () => {
    const socket = require('ws');
    const inherited = Object.keys(Object.getPrototypeOf(socket))[0];
    expect(inherited).toBeTruthy();
    expect(Object.hasOwn(socket, inherited)).toBe(false);

    const bundle = await rollup({
      input: 'entry',
      external: ['ws'],
      plugins: [{
        name: 'namespace-fixture',
        resolveId: id => id === 'entry' ? id : null,
        load: id => id === 'entry'
          ? "import * as socket from 'ws'; export { socket };"
          : null,
      }],
    });
    try {
      const { output } = await bundle.generate({
        format: 'cjs',
        generatedCode: { constBindings: true },
        externalLiveBindings: true,
      });
      const exports: { socket?: Record<string, unknown> } = {};
      runInNewContext(output[0].code, { exports, require });
      expect(exports.socket?.default).toBe(socket);
      expect(exports.socket?.WebSocket).toBe(socket.WebSocket);
      expect(exports.socket?.[inherited]).toBe(socket[inherited]);
      expect(Object.getOwnPropertyDescriptor(exports.socket, 'WebSocket')?.get)
        .toBeTypeOf('function');
    } finally {
      await bundle.close();
    }
  });
});
