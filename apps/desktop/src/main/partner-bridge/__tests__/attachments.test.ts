/**
 * attachments.test.ts
 * ---------------------------------------------------------------------------
 * 终稿引用 → 附件清单的解析与 fail-closed 校验:路径不在允许根内、没有允许根、
 * 解析不出图片 URL,都只跳过该项并留下正文提示,不抛错。
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { collectPartnerAttachments } from '../attachments.js';

const ROOT = path.resolve('/tmp/partner-root');

function createDeps(overrides: Partial<Parameters<typeof collectPartnerAttachments>[2]> = {}) {
  const warnings: string[] = [];
  return {
    warnings,
    deps: {
      resolveImageUrl: (url: string) => (url.startsWith('xdt-image://') ? path.join(ROOT, 'a.png') : null),
      realpath: async (p: string) => p,
      statSize: async () => 1234,
      log: { warn: (message: string) => warnings.push(message) },
      ...overrides,
    },
  };
}

describe('partner attachments', () => {
  it('收集图片与文件引用并把正文里的引用替换成提示', async () => {
    const { deps } = createDeps();
    const text = [
      '做好了:',
      '![图](xdt-image://image/a.png)',
      `[报表](xdt-file://${path.join(ROOT, '报表.xlsx')})`,
    ].join('\n');

    const result = await collectPartnerAttachments(text, [ROOT], deps);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toMatchObject({ name: 'a.png', kind: 'image', bytes: 1234 });
    expect(result.attachments[1]).toMatchObject({ name: '报表.xlsx', kind: 'file' });
    expect(result.text).toContain('（图片已作为附件提供）');
    expect(result.text).toContain('（已作为附件提供）');
    expect(result.text).not.toContain('xdt-image://');
  });

  it('允许根之外的文件引用被跳过', async () => {
    const { deps, warnings } = createDeps();
    const text = `[密钥](xdt-file://${path.resolve('/etc/hosts')})`;

    const result = await collectPartnerAttachments(text, [ROOT], deps);

    expect(result.attachments).toHaveLength(0);
    expect(warnings.join(' ')).toContain('outside allowed roots');
  });

  it('没有允许根时不收任何文件引用(fail-closed)', async () => {
    const { deps } = createDeps();
    const text = `[文件](xdt-file://${path.join(ROOT, '报表.xlsx')})`;

    const result = await collectPartnerAttachments(text, [], deps);

    expect(result.attachments).toHaveLength(0);
  });

  it('同一路径只收一次,解析不出的图片只记日志', async () => {
    const { deps, warnings } = createDeps({
      resolveImageUrl: () => null,
    });
    const text = [
      `[a](xdt-file://${path.join(ROOT, '报表.xlsx')})`,
      `[b](xdt-file://${path.join(ROOT, '报表.xlsx')})`,
      '![x](xdt-image://image/missing.png)',
    ].join('\n');

    const result = await collectPartnerAttachments(text, [ROOT], deps);

    expect(result.attachments).toHaveLength(1);
    expect(warnings.join(' ')).toContain('image unresolved');
    // 没收集到的图片不能对调用方声称"已提供"。
    expect(result.text).toContain('附图未能提供');
  });
});
