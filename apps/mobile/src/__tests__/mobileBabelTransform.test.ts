import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../metro.config.js');
const transformer = require(config.transformer.babelTransformerPath);
const generate = require('@babel/generator').default;
const projectRoot = path.resolve(__dirname, '../..');

afterEach(() => vi.unstubAllEnvs());

function compileWorklet(dev: boolean) {
  const { ast } = transformer.transform({
    // The Worklets development transform reads this file for its source map.
    filename: __filename,
    src: "function calculate() { 'worklet'; return 42; }",
    options: {
      dev, platform: 'ios', projectRoot, enableBabelRCLookup: true,
      customTransformOptions: { engine: 'hermes' },
    },
    plugins: [],
  });
  return new Function(`${generate(ast).code}; return calculate;`)();
}

it('release worklets omit debug allocations even when the build inherits development variables', () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('BABEL_ENV', 'development');
  const worklet = compileWorklet(false);
  expect(worklet()).toBe(42);
  expect(worklet.__workletHash).toEqual(expect.any(Number));
  expect(worklet.__stackDetails).toBeUndefined();
  expect(worklet.__initData.sourceMap).toBeUndefined();
  expect(process.env.NODE_ENV).toBe('development');
  expect(process.env.BABEL_ENV).toBe('development');
});

it('development worklets retain debugging even when the parent environment says production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BABEL_ENV', 'production');
  const worklet = compileWorklet(true);
  expect(worklet()).toBe(42);
  expect(worklet.__stackDetails[0]).toBeInstanceOf(Error);
  expect(worklet.__initData.sourceMap).toEqual(expect.any(String));
  expect(process.env.NODE_ENV).toBe('production');
  expect(process.env.BABEL_ENV).toBe('production');
});
