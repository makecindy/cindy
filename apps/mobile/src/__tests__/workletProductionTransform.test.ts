import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type BabelTransformResult = { code?: string | null };
type Babel = {
  transformFileSync: (filename: string, options: Record<string, unknown>) => BabelTransformResult;
};
type WorkletFunction = ((input: unknown) => unknown) & {
  __closure?: Record<string, unknown>;
};

const require = createRequire(import.meta.url);
const babel = require('@babel/core') as Babel;
const expoPreset = require('babel-preset-expo');

/** Evaluate a pure model module after the same transform used by Android release bundles. */
function loadProductionModule(relativePath: string): Record<string, unknown> {
  const filename = resolve(process.cwd(), relativePath);
  const transformed = babel.transformFileSync(filename, {
    babelrc: false,
    configFile: false,
    envName: 'production',
    filename,
    presets: [[expoPreset, { platform: 'android' }]],
  });
  if (!transformed.code) throw new Error(`Babel produced no code for ${relativePath}`);
  const moduleExports: Record<string, unknown> = {};
  const evaluate = Function('exports', transformed.code) as (exports: Record<string, unknown>) => void;
  evaluate(moduleExports);
  return moduleExports;
}

function worklet(moduleExports: Record<string, unknown>, name: string): WorkletFunction {
  const value = moduleExports[name];
  expect(typeof value).toBe('function');
  return value as WorkletFunction;
}

describe('Android production worklet transform', () => {
  it('initializes composer resize helper closures before the UI gesture calls them', () => {
    const moduleExports = loadProductionModule('src/session/composerResize.ts');
    const applyComposerResizeDrag = worklet(moduleExports, 'applyComposerResizeDrag');

    expect(typeof applyComposerResizeDrag.__closure?.normalizeBounds).toBe('function');
    expect(typeof applyComposerResizeDrag.__closure?.clamp).toBe('function');
    expect(applyComposerResizeDrag({
      bounds: { minContentHeight: 20, maxContentHeight: 200 },
      startContentHeight: 40,
      translationY: -10,
    })).toBe(50);
  });

  it('initializes context sheet helper closures before UI drag and settle worklets call them', () => {
    const moduleExports = loadProductionModule('src/session/contextSheetModel.ts');
    const applyContextSheetDrag = worklet(moduleExports, 'applyContextSheetDrag');
    const settleContextSheetDrag = worklet(moduleExports, 'settleContextSheetDrag');

    expect(typeof applyContextSheetDrag.__closure?.normalizeHeights).toBe('function');
    expect(typeof applyContextSheetDrag.__closure?.clamp).toBe('function');
    expect(typeof settleContextSheetDrag.__closure?.normalizeHeights).toBe('function');
    expect(applyContextSheetDrag({
      heights: { half: 320, full: 700 },
      startHeight: 320,
      translationY: -100,
    })).toBe(420);
    expect(settleContextSheetDrag({
      heights: { half: 320, full: 700 },
      draggedHeight: 600,
    })).toBe('full');
  });
});
