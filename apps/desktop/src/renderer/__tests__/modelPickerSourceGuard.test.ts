/**
 * 所有模型选择器必须包含远程模型；只有运行时确实不能跑到别的电脑的入口才能列为例外。
 * 类型要求每个入口声明来源，这里再把例外锁成清单：新增例外必须同时改这里和
 * docs/product-rules/model-selector-unified.md。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

const LOCAL_ONLY_ENTRIES: Record<string, string[]> = {
  'cindy-brain/OneshotModelPinPicker.tsx': ['one-shot-local-request'],
  'cindy-brain/PluginTaskPrefs.tsx': ['plugin-task-local-route', 'one-shot-local-request'],
  'components/settings/SubagentModelSection.tsx': ['subagent-in-parent-task'],
  'components/settings/VisionBridgeSection.tsx': ['vision-bridge-local-proxy'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const sources = sourceFiles(ROOT).map((path) => ({
  file: relative(ROOT, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('模型选择器的来源声明', () => {
  it('只限本机的入口与例外清单完全一致', () => {
    const found: Record<string, string[]> = {};
    for (const { file, text } of sources) {
      if (file === 'components/new-chat/ModelSelector.tsx') continue;
      const reasons = [...text.matchAll(/['"](subagent-in-parent-task|vision-bridge-local-proxy|one-shot-local-request|plugin-task-local-route)['"]/g)]
        .map((match) => match[1]);
      if (/localOnlyReason/.test(text)) found[file] = [...new Set(reasons)];
    }
    expect(found).toEqual(LOCAL_ONLY_ENTRIES);
  });

  it('生产代码不能写死 remoteAgent={undefined} 绕过声明', () => {
    expect(sources.filter(({ text }) => /remoteAgent=\{undefined\}/.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
