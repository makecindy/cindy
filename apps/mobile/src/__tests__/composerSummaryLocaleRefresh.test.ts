import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * composer / 新会话草稿摘要里的 effort 与权限标签按当前 app 语言解析,
 * memo 依赖必须带上语言,否则切换语言后已挂载的路由会停在上一语言。
 */
describe('composer 摘要随 app 语言重算', () => {
  it('会话页 composerRuntimeSummary memo 依赖包含 i18n 语言', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const memo = source.slice(source.indexOf('const composerRuntimeSummary = useMemo('));
    const deps = memo.slice(memo.indexOf('['), memo.indexOf(']') + 1);

    expect(deps).toContain('i18nInstance.language');
  });

  it('新建会话页 runtimeSummary memo 依赖包含 i18n 语言', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8');
    const memo = source.slice(source.indexOf('const runtimeSummary = useMemo('));
    const deps = memo.slice(memo.indexOf('['), memo.indexOf(']') + 1);

    expect(deps).toContain('i18nInstance.language');
  });
});
