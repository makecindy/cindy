import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { resolveStartupSplashHandoff } from '../startupSplashContinuity';

// Greptile P1 / DESIGN §16.5: do not flash the system dark theme while first-launch
// storage is pending. Evaluate the real eager module per boot, without resetting
// the runner's dependency graph, and execute its actual brand-stage consumer.
const gateCode = ts.transpileModule(readFileSync(resolve(process.cwd(), 'src/auth/loginFirstLaunchGate.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const stageAst = ts.createSourceFile('stage.tsx', readFileSync(resolve(process.cwd(), 'src/components/MobileLoginHandoffStage.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const stageNode = stageAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'MobileLoginHandoffStage');
if (!stageNode) throw new Error('brand-stage entry missing');
const stageCode = ts.transpileModule(stageNode.getText(stageAst), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;

describe('loginFirstLaunchGate boot and stage rendering', () => {
  it.each([null, 'already-shown', 'storage-error'])('keeps branding hidden until storage resolves to %j', async (value) => {
    let resolveRead!: (value: string | null) => void;
    let rejectRead!: (error: Error) => void;
    const getItem = vi.fn(() => new Promise<string | null>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }));
    const setItem = vi.fn(async () => undefined);
    const exports: Record<string, any> = {};
    runInNewContext(gateCode, { exports, require: (id: string) => id === 'react' ? {} : { __esModule: true, default: { getItem, setItem } } });
    const stageExports: Record<string, any> = {};
    runInNewContext(stageCode, {
      exports: stageExports, React, resolveStartupSplashHandoff,
      useLoginFirstLaunchLight: exports.getLoginFirstLaunchGateState, useTheme: () => ({ mode: 'dark' }),
      ThemeOverrideProvider: 'theme-provider', MobileLoginHandoffStageInner: 'brand-stage',
    });
    expect(exports.getLoginFirstLaunchGateState()).toBe('pending');
    expect(stageExports.MobileLoginHandoffStage({})).toBeNull();
    if (value === 'storage-error') rejectRead(new Error('storage unavailable'));
    else resolveRead(value);
    await Promise.resolve();
    await Promise.resolve();
    expect(exports.getLoginFirstLaunchGateState()).toBe(value === null ? 'light' : 'passthrough');
    const rendered = stageExports.MobileLoginHandoffStage({ testID: 'fixture' });
    expect(rendered.props.mode).toBe(value === null ? 'light' : 'dark');
    expect(rendered.props.children.props.testID).toBe('fixture');
    expect(getItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledTimes(value === null ? 1 : 0);
    if (value === null) expect(setItem).toHaveBeenCalledWith('cindy.login.firstLaunchLightShown', expect.any(String));
  });
});
