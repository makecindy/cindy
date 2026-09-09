// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => sandbox.home }, homedir: () => sandbox.home };
});
vi.mock('../../../../main/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { loadLocalThemesSync, resetLocalThemesMigrationForTest } from '../../../../main/local-themes/loader';
import '../../../themes/colors';
import { bootstrapLocalThemesSync, getLocalThemes } from '../../../themes/local-themes';
import { exportThemeColors, resolveThemeValue } from '../../../themes/theme-service';
import { builtinThemes } from '../../../themes/registry';
import type { Theme, ThemeType } from '../../../themes/types';
import { SettingsTextInput } from '../../settings/SettingsTextInput';
import { Input } from '../input';

const BINDINGS = [
  ['text-', 'text-primary', 'settings-input-text'],
  ['border-', 'border-default', 'settings-input-border'],
  ['focus:border-', 'text-tertiary-stone', 'settings-input-border-focus'],
  ['placeholder:text-', 'text-placeholder', 'settings-input-placeholder'],
] as const;

// 复用既有内置色板作为彼此不同的全局/局部覆盖，不另维护测试色值表。
const SEMANTIC = Object.fromEntries(BINDINGS.map(([, semantic]) => [
  semantic, resolved(builtinThemes['default-light'], semantic),
]));
const LEGACY = Object.fromEntries(BINDINGS.map(([, semantic, alias]) => [
  alias, resolved(builtinThemes['default-dark'], semantic),
]));

// jsdom 不负责 Tailwind/CSS 变量计算。此处从真实 React 控件读取消费表达式，
// 通过生产 registry 解析到值，补齐“文件还在但控件不再消费”的回归边界。
// 浏览器最终 computed style 另由真实 Desktop 验证，不能把此测试冒充实机证据。
function resolved(theme: Theme, id: string, depth = 0): string {
  if (depth > 12) throw new Error(`Unexpected alias cycle: ${id}`);
  const value = resolveThemeValue(theme, id);
  if (value === null) throw new Error(`Missing color: ${id}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(value);
  return alias ? resolved(theme, alias[1], depth + 1) : value;
}

function consumed(field: HTMLInputElement, prefix: string, theme: Theme): string {
  const token = [...field.classList].find((item) => item.startsWith(`${prefix}[var(--`));
  const id = token?.match(/var\(--([\w-]+)\)/)?.[1];
  if (!id) throw new Error(`Missing ${prefix} color binding: ${field.className}`);
  return resolved(theme, id);
}

function loadTheme(type: ThemeType, colors: Record<string, string>): Theme {
  const dir = path.join(sandbox.home, '.cindy', 'themes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'input-compat.json');
  const bytes = `${JSON.stringify({ id: 'input-compat', name: 'Input compatibility fixture', type, colors }, null, 2)}\n`;
  fs.writeFileSync(file, bytes);
  const payload = loadLocalThemesSync();
  expect(payload.success).toBe(true);
  vi.stubGlobal('electronAPI', { localThemes: { listSync: () => payload } });
  bootstrapLocalThemesSync();
  const first = getLocalThemes().find((theme) => theme.id === 'input-compat-local');
  expect(first).toBeDefined();
  bootstrapLocalThemesSync();
  expect(getLocalThemes().find((theme) => theme.id === first!.id)).toEqual(first);
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  return first!;
}

beforeEach(() => {
  sandbox.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-input-compat-')));
  resetLocalThemesMigrationForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fs.rmSync(sandbox.home, { recursive: true, force: true });
});

describe.each(['light', 'dark'] as const)('旧设置输入主题消费：%s', (type) => {
  it.each([
    ['仅全局覆盖', SEMANTIC],
    ['旧局部覆盖与全局覆盖并存', { ...SEMANTIC, ...LEGACY }],
    ['旧文件缺新 placeholder slot', LEGACY],
    ['完整本地副本含局部覆盖', { ...exportThemeColors(builtinThemes[`default-${type}`]), ...SEMANTIC, ...LEGACY }],
  ] as const)('%s：旧设置输入保留局部作用域，通用 Input 保持语义默认', (_name, colors) => {
    const original = JSON.stringify(colors);
    const theme = loadTheme(type, colors);
    const { container } = render(<>
      <SettingsTextInput value="legacy" onChange={() => {}} />
      <Input value="general" onChange={() => {}} />
    </>);
    const [legacy, general] = container.querySelectorAll('input');
    for (const [prefix, semantic, alias] of BINDINGS) {
      expect(consumed(legacy, prefix, theme), `${prefix} legacy input`).toBe(resolved(theme, alias));
      expect(consumed(general, prefix, theme), `${prefix} general input`).toBe(resolved(theme, semantic));
    }
    expect(JSON.stringify(colors)).toBe(original);
  });
});

it('所有内置主题未做局部覆盖时，旧设置封装与标准 Input 逐值相同', () => {
  const { container } = render(<>
    <SettingsTextInput value="legacy" onChange={() => {}} />
    <Input value="general" onChange={() => {}} />
  </>);
  const [legacy, general] = container.querySelectorAll('input');
  for (const theme of Object.values(builtinThemes)) {
    for (const [prefix] of BINDINGS) {
      expect(consumed(legacy, prefix, theme), `${theme.id} ${prefix}`).toBe(consumed(general, prefix, theme));
    }
  }
});

it('局部主题兼容不能盖掉标准错误态', () => {
  const theme = loadTheme('light', { ...SEMANTIC, ...LEGACY });
  const { container } = render(<SettingsTextInput value="invalid" onChange={() => {}} error />);
  const field = container.querySelector('input')!;
  expect(consumed(field, 'border-', theme)).toBe(resolved(theme, 'error-border'));
  expect(consumed(field, 'focus:border-', theme)).toBe(resolved(theme, 'error-fg'));
  expect(consumed(field, 'text-', theme)).toBe(LEGACY['settings-input-text']);
});
