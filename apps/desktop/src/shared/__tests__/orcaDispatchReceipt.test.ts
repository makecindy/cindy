/**
 * 回执摘要是一句旁证，读它的人不该看到 `##`、反引号和 `**`。
 *
 * Bug 依据：派单正文的 markdown 原样进了卡片，用户看到的是「## 三个症状一个根…**保存时」这样的残渣。
 * 修法放在写入端（这里），卡片/历史/导出读到的就是同一句干净的话。
 */

import { describe, expect, it } from 'vitest';

import { ORCA_DISPATCH_RECEIPT_SUMMARY_MAX, buildOrcaDispatchReceiptSummary } from '../orcaDispatchReceipt.js';

describe('buildOrcaDispatchReceiptSummary', () => {
  it('strips markdown markers so the receipt reads as one sentence', () => {
    const summary = buildOrcaDispatchReceiptSummary(
      [
        '## 三个症状一个根',
        '改判值写进了总分，没写进 `marks`。',
        '**先验证，再改**：见 [设计说明](https://example.com/doc)。',
      ].join('\n'),
    );

    expect(summary).toBe('三个症状一个根 改判值写进了总分，没写进 marks。 先验证，再改：见 设计说明。');
  });

  it('keeps filenames inside inline code intact', () => {
    const summary = buildOrcaDispatchReceiptSummary('修 `pkg/__init__.py` 与 `a*b*c` 两处');

    expect(summary).toBe('修 pkg/__init__.py 与 a*b*c 两处');
  });

  it('keeps bare asterisks and list markers out while collapsing whitespace', () => {
    const summary = buildOrcaDispatchReceiptSummary('- 第一项\n- 第二项\n\n> 引用一句');

    expect(summary).toBe('第一项 第二项 引用一句');
  });

  it('drops fenced code instead of leaking it into the one-line fact', () => {
    const summary = buildOrcaDispatchReceiptSummary('看这段：\n```ts\nconst a = 1;\n```\n然后修');

    expect(summary).toBe('看这段： 然后修');
  });

  it('caps the summary and marks the truncation', () => {
    const summary = buildOrcaDispatchReceiptSummary('长'.repeat(ORCA_DISPATCH_RECEIPT_SUMMARY_MAX + 20));

    expect(summary).toHaveLength(ORCA_DISPATCH_RECEIPT_SUMMARY_MAX);
    expect(summary.endsWith('…')).toBe(true);
  });
});
