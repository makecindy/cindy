/**
 * 手机端所有模型选择器必须包含远程模型；只限本机的入口锁成清单，规则见
 * docs/product-rules/model-selector-unified.md。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');

const ENTRIES: Record<string, 'remote' | 'plugin-task-local-route'> = {
  'app/sessions/new.tsx': 'remote',
  'app/sessions/[sessionId].tsx': 'remote',
  'src/session/CompanionModelChain.tsx': 'remote',
  'src/plugins/PluginScheduleDraft.tsx': 'remote',
  // #8460 合并后 PluginModelPicker 改为 remote。
  'src/plugins/PluginModelPicker.tsx': 'plugin-task-local-route',
  'src/plugins/PluginTaskSettings.tsx': 'plugin-task-local-route',
};

describe('手机模型选择器的来源声明', () => {
  it.each(Object.entries(ENTRIES))('%s 声明 %s', (path, source) => {
    const text = read(path);
    expect(text).toContain('<ModelPickerSheet');
    if (source === 'remote') {
      expect(text).toMatch(/remote: \{|remote: remoteSupported|remote: undefined/);
      expect(text).not.toContain('localOnlyReason');
    } else {
      expect(text).toContain(`localOnlyReason: "${source}"`);
    }
  });
});
