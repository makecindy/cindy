/**
 * 手机端所有模型选择器必须包含远程模型，目前没有只限本机的入口，规则见
 * docs/product-rules/model-selector-unified.md。扫描生产源码里实际出现的
 * ModelPickerSheet 调用文件，新增入口不登记就失败。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

type Source = 'remote';

const ENTRIES: Record<string, Source> = {
  'app/sessions/new.tsx': 'remote',
  'app/sessions/[sessionId].tsx': 'remote',
  'src/session/CompanionModelChain.tsx': 'remote',
  'src/plugins/PluginScheduleDraft.tsx': 'remote',
  'src/plugins/PluginModelPicker.tsx': 'remote',
  // 旧版电脑不保存运行位置时 remote 为 undefined，只列那台电脑的模型。
  'src/plugins/PluginTaskSettings.tsx': 'remote',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const callers = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'src'))]
  .map((path) => ({
    file: relative(ROOT, path).split('\\').join('/'),
    text: readFileSync(path, 'utf8'),
  }))
  .filter(({ file, text }) => file !== 'src/session/ModelPickerSheet.tsx' && /<ModelPickerSheet[\s>]/.test(text));

describe('手机模型选择器的来源声明', () => {
  it('实际调用 ModelPickerSheet 的文件与登记清单完全一致', () => {
    expect(callers.map(({ file }) => file).sort()).toEqual(Object.keys(ENTRIES).sort());
  });

  it.each(callers)('$file 声明来源', ({ file, text }) => {
    expect(ENTRIES[file]).toBe('remote');
    expect(text).toMatch(/remote: \{|remote: remoteSupported|remote: undefined/);
    expect(text).not.toContain('localOnlyReason');
  });
});
