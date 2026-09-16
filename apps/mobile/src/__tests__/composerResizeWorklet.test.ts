/**
 * #4039 回归:输入框拖拽的 UI 线程 worklet 在 Android release 包里崩溃
 * (`undefined is not a function at applyComposerResizeDrag`)。
 *
 * 根因不在逻辑而在**声明顺序**:react-native-worklets 的 babel 插件把每个 `'worklet'`
 * 函数改写成「模块求值时立即执行的工厂」,并在那一刻把它引用的模块内标识符抓进
 * `__closure`。`applyComposerResizeDrag` 若写在它依赖的 `normalizeBounds` / `clamp`
 * 之前,抓到的就是两个尚未赋值的 `var`(undefined);UI 线程按 `__closure` 取值调用即崩。
 * vitest 走 esbuild、不跑该插件,普通单测永远发现不了 —— 本测试用仓库实际的 babel
 * preset + worklets 插件把源码真转译一遍并求值,断言闭包里拿到的是函数。
 */
import { describe, expect, it } from 'vitest';
import { transformFileSync, type TransformOptions } from '@babel/core';
import Module, { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sourcePath = path.resolve(__dirname, '..', 'session', 'composerResize.ts');

interface WorkletLike {
  (...args: unknown[]): unknown;
  __closure?: Record<string, unknown>;
  __workletHash?: number;
}

function loadWorkletTransformedModule(): Record<string, unknown> {
  const out = transformFileSync(sourcePath, {
    filename: sourcePath,
    babelrc: false,
    configFile: false,
    presets: [[require.resolve('babel-preset-expo'), {}]],
    plugins: [require.resolve('react-native-worklets/plugin')],
    // Metro 的 caller 带 platform 字段(babel-preset-expo 据此选平台分支),类型定义里没有。
    caller: {
      name: 'metro',
      supportsStaticESM: false,
      platform: 'android',
    } as unknown as TransformOptions['caller'],
    envName: 'production',
  });
  if (!out?.code) throw new Error('babel produced no output');
  const compiledPath = sourcePath.replace(/\.ts$/, '.js');
  const mod = new Module(compiledPath);
  const nodeModulePaths = (
    Module as unknown as { _nodeModulePaths: (from: string) => string[] }
  )._nodeModulePaths;
  mod.paths = nodeModulePaths(path.dirname(sourcePath));
  (mod as unknown as { _compile: (code: string, filename: string) => void })._compile(
    out.code,
    compiledPath,
  );
  return mod.exports as Record<string, unknown>;
}

describe('composerResize worklets(经 react-native-worklets 插件转译后)', () => {
  it('applyComposerResizeDrag 的 __closure 在模块求值时已拿到辅助函数,UI 线程可调用', () => {
    const exported = loadWorkletTransformedModule();
    const worklet = exported.applyComposerResizeDrag as WorkletLike;
    expect(typeof worklet).toBe('function');
    expect(typeof worklet.__workletHash).toBe('number');
    const closure = worklet.__closure ?? {};
    // 本次回归只关乎两个辅助函数的声明顺序:它们必须以函数身份进入闭包。
    expect(typeof closure.normalizeBounds, '__closure.normalizeBounds').toBe('function');
    expect(typeof closure.clamp, '__closure.clamp').toBe('function');
    // 更一般的约束是「抓进闭包的标识符不能是尚未赋值的 var」;worklet 合法捕获常量 /
    // 对象在仓库里有先例,所以只拒绝 undefined,不限定类型。
    for (const [name, value] of Object.entries(closure)) {
      expect(value, `__closure.${name}`).not.toBeUndefined();
    }
    // 转译后的 JS 线程副本与 UI 线程副本共用同一份闭包捕获:直接调用等价于 UI 线程调用。
    expect(worklet({
      startContentHeight: 100,
      translationY: -20,
      bounds: { minContentHeight: 20, maxContentHeight: 300 },
    })).toBe(120);
  });
});
