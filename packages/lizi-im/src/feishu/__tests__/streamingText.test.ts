import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patchCardRaw: vi.fn(),
  getAccountEpoch: vi.fn(() => 1),
  rearmAnchorToTrigger: vi.fn(),
  recallMessage: vi.fn(),
  sendCardRaw: vi.fn(),
  sendFile: vi.fn(),
  sendText: vi.fn(),
  uploadImage: vi.fn(),
  claimPatchableOpener: vi.fn((): string | null => null),
  resolveMediaUrl: vi.fn((): string | null => null),
}));

vi.mock('../outbound.js', () => mocks);
vi.mock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
  getLog: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
  getHost: () => ({
    media: { resolveMediaUrl: mocks.resolveMediaUrl },
    paths: { feishuMediaDir: '/tmp/feishu-media' },
  }),
}));

import { messages } from '../messages.js';
import { FEISHU_CARD_REQUEST_MAX_BYTES, start, patchMarkdown } from '../streamingText.js';

function markdownContent(card: unknown): string {
  return (card as { body: { elements: Array<{ content: string }> } }).body.elements[0].content;
}

function requestBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) }), 'utf8');
}

type CardElement = { tag: string; content?: string; img_key?: string };

function cardElements(card: unknown): CardElement[] {
  return (card as { body: { elements: CardElement[] } }).body.elements;
}

/** The answer text one card carries (markdown elements only, in order). */
function cardMarkdown(card: unknown): string {
  return cardElements(card)
    .filter((element) => element.tag === 'markdown')
    .map((element) => element.content ?? '')
    .join('\n');
}

/** Every card of one final answer, in delivery order: the edited card, then the new ones. */
function deliveredCards(): unknown[] {
  return [
    ...mocks.patchCardRaw.mock.calls.map((call) => call[1]),
    ...mocks.sendCardRaw.mock.calls.slice(1).map((call) => call[1]),
  ];
}

describe('feishu streaming text', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAccountEpoch.mockReturnValue(1);
    mocks.sendCardRaw.mockResolvedValueOnce({ messageId: 'om_stream' }).mockResolvedValue({ messageId: 'om_final' });
    mocks.patchCardRaw.mockResolvedValue(undefined);
    mocks.sendFile.mockResolvedValue({
      ok: true,
      messageId: 'om_primary_file',
    });
    mocks.sendText.mockResolvedValue({ messageId: 'om_fallback' });
    mocks.resolveMediaUrl.mockReturnValue(null);
  });

  it('updates the original card with the final answer without sending or recalling a message', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('正常正文');

    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('正常正文');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(handle.messageId).toBe('om_stream');
  });

  it.each(['', ' \n '])('recalls an empty final %j without a placeholder', async (text) => {
    const handle = await start('ou_owner');
    await handle.finalize(text);
    await handle.finalize(text);
    expect(mocks.recallMessage).toHaveBeenCalledExactlyOnceWith('om_stream');
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('recalls an existing interaction/opener card when its final is empty', async () => {
    await patchMarkdown('om_opener', ' \n ');
    expect(mocks.recallMessage).toHaveBeenCalledWith('om_opener');
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
  });

  it('keeps attachment-only finals', async () => {
    mocks.uploadImage.mockResolvedValue('image_key');
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/image.png');
    await handle.finalize('');
    expect(mocks.uploadImage).toHaveBeenCalledWith('/tmp/image.png');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    const card = mocks.patchCardRaw.mock.calls[0][1];
    expect(card.body.elements).toEqual([expect.objectContaining({ tag: 'img', img_key: 'image_key' })]);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  // Rule: an answer that does not fit one Feishu card (30 KB request body, 4 tables per
  // markdown element) is delivered in full across cards, never truncated.
  // Production entry: finalize -> patchCardRaw (first card) + sendCardRaw (the rest).
  // Coverage gap: the previous test only pinned the truncation notice this replaces.
  // Minimal failing input: one code block and one table that each exceed a card, plus
  // more small tables than one card may hold; unit tier with mocked outbound.
  it('delivers an oversized final in full across cards, keeping code blocks and tables whole', async () => {
    const handle = await start('ou_owner', 'working', { threadTs: 'om_root' });
    const codeLines = Array.from({ length: 1500 }, (_, i) => `const line${i} = "代码行";`);
    const tableRows = Array.from({ length: 1200 }, (_, i) => `| 行${i} | 一些内容 |`);
    const smallTables = Array.from(
      { length: 6 },
      (_, i) => `小表 ${i}\n\n| 名称 | 值 |\n| --- | --- |\n| k${i} | v${i} |`,
    );
    await handle.finalize(
      [
        '# 标题\n\n开头的说明。',
        ['```ts', ...codeLines, '```'].join('\n'),
        ['| 列一 | 列二 |', '| --- | --- |', ...tableRows].join('\n'),
        ...smallTables,
        '结尾的总结。',
      ].join('\n\n'),
    );

    const cards = deliveredCards();
    expect(cards.length).toBeGreaterThan(2);
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    for (const call of mocks.sendCardRaw.mock.calls.slice(1)) {
      expect(call[2]).toEqual({ threadTs: 'om_root', advanceRound: false });
    }
    const texts = cards.map(cardMarkdown);
    for (const [index, card] of cards.entries()) {
      const text = texts[index];
      expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
      expect(text.split('\n').filter((line) => line === '| --- | --- |').length).toBeLessThanOrEqual(4);
      // A part that carries code opens and closes its own fence; table rows sit under a header.
      expect(text.split('\n').filter((line) => line.startsWith('```')).length % 2).toBe(0);
      const firstRow = text.split('\n').findIndex((line) => line.startsWith('| 行'));
      if (firstRow >= 0) {
        expect(text.split('\n').slice(firstRow - 2, firstRow)).toEqual(['| 列一 | 列二 |', '| --- | --- |']);
      }
      expect(text).toContain(messages.streaming.partNote(index + 1, cards.length));
    }
    const everything = texts.join('\n');
    expect(everything.split('\n').filter((line) => line.startsWith('const line'))).toEqual(codeLines);
    expect(everything.split('\n').filter((line) => line.startsWith('| 行'))).toEqual(tableRows);
    for (const piece of ['开头的说明。', '| k5 | v5 |', '结尾的总结。']) expect(everything).toContain(piece);
    expect(everything).not.toContain('桌面端');
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  // Rule: splitting must not change what the reader receives. Review #9746 (codex P2): the splitter
  // trimmed trailing spaces and blank lines at a cut inside a code block, so Python triple-quoted
  // strings, heredocs and text samples came back different. Production entry: finalize.
  // Minimal failing input: one code block whose lines end in two spaces and include blank lines,
  // longer than a card; unit tier.
  it('keeps trailing spaces and blank lines of a code block that is split across cards', async () => {
    const handle = await start('ou_owner');
    const codeLines = Array.from({ length: 1500 }, (_, i) => (i % 7 === 3 ? '' : `const line${i} = "代码行";  `));
    await handle.finalize(['```py', ...codeLines, '```'].join('\n'));

    const cards = deliveredCards();
    expect(cards.length).toBeGreaterThan(1);
    const received = cards.flatMap((card) => {
      const body = cardElements(card).find((element) => element.tag === 'markdown')?.content ?? '';
      return body.split('\n').slice(1, -1);
    });
    expect(received).toEqual(codeLines);
  });

  // Review #9746 (greptile P2): a single table row longer than a card was cut by characters without
  // its header, so later cards began mid-cell with no columns. Production entry: finalize.
  // Minimal failing input: a header, a separator and one row whose first cell exceeds 30 KB; unit tier.
  it('keeps the table header on every card when one row alone exceeds a card', async () => {
    const handle = await start('ou_owner');
    const header = '| 列一 | 列二 |';
    const separator = '| --- | --- |';
    await handle.finalize([header, separator, `| ${'很长的内容'.repeat(5000)} | 第二列 |`].join('\n'));

    const cards = deliveredCards();
    expect(cards.length).toBeGreaterThan(2);
    const bodies = cards.map((card) => cardElements(card).find((element) => element.tag === 'markdown')?.content ?? '');
    for (const [index, card] of cards.entries()) {
      expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
      expect(bodies[index].split('\n').slice(0, 2)).toEqual([header, separator]);
    }
    // Nothing of the long cell or the second column is lost.
    expect(bodies.join('').split('很').length - 1).toBe(5000);
    expect(bodies.at(-1)).toContain('第二列');
  });

  // Rule: a later card that cannot be sent stops the sequence with one visible notice;
  // the remaining parts are not posted after a gap. Unit tier; no earlier coverage.
  it('stops with a notice when a following card cannot be sent', async () => {
    const handle = await start('ou_owner');
    mocks.sendCardRaw.mockReset();
    mocks.sendCardRaw.mockRejectedValue(new Error('rate limited'));
    await handle.finalize(Array.from({ length: 4000 }, (_, i) => `第 ${i} 段内容，足够长。`).join('\n\n'));

    expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledExactlyOnceWith(
      'ou_owner',
      messages.streaming.continuationFailed,
      undefined,
    );
  });

  // Rule: the turn's process record stays reviewable after completion as a collapsed
  // panel above the answer (previously the process region was dropped at done).
  // Production entry: finalize(text, { process }); unit tier; no earlier coverage.
  it('keeps the process record as a collapsed panel above the final answer', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('正文', {
      process: { title: '过程记录 · 2 项 · 8s', lines: ['✓ 读取 a.ts', '✓ 搜索 foo'] },
    });

    const [panel, body] = cardElements(mocks.patchCardRaw.mock.calls[0][1]) as Array<
      CardElement & { expanded?: boolean; header?: { title: { content: string } }; elements?: CardElement[] }
    >;
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.header?.title.content).toBe('过程记录 · 2 项 · 8s');
    expect(panel.elements?.[0].content).toBe('✓ 读取 a.ts\n✓ 搜索 foo');
    expect(body).toEqual({ tag: 'markdown', content: '正文' });
  });

  // Regression: an oversized intermediate frame used to bypass the final-card byte cap.
  // Production entry: append/timer -> patchCardRaw; existing coverage only checked finalize.
  // Minimal failing input: one multi-byte Markdown frame; unit tier with fake timers/mocks.
  it('shows the fitting head of an oversized intermediate frame and says the rest will follow', async () => {
    vi.useFakeTimers();
    try {
      const handle = await start('ou_owner');
      const longMarkdown = '| 列一 | 列二 |\n| --- | --- |\n| 很长的内容 | 更多内容 |'.repeat(1000);
      handle.append(longMarkdown);
      await vi.advanceTimersByTimeAsync(1500);

      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
      const card = mocks.patchCardRaw.mock.calls[0][1];
      expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
      expect(markdownContent(card).endsWith(messages.streaming.replyContinues)).toBe(true);
      expect(markdownContent(card).length).toBeGreaterThan(5000);
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('delivers a file separately and updates the original card with its receipt', async () => {
    const handle = await start('ou_owner');
    await handle.finalize('[report.txt](xdt-file:///tmp/report.txt)');
    expect(mocks.sendFile).toHaveBeenCalledExactlyOnceWith('ou_owner', '/tmp/report.txt', 'report.txt', undefined);
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe(messages.streaming.fileSentDone(1));
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  // Rule: images that do not fit the answer's card follow in further cards instead of
  // replacing the whole answer with a failure notice. Unit tier with mocked uploads.
  it('sends images that overflow one card in following cards', async () => {
    mocks.uploadImage.mockImplementation(async (path: string) => `${path}-${'x'.repeat(128)}`);
    const handle = await start('ou_owner');
    for (let i = 0; i < 200; i++) handle.addExtraImageAbsPath?.(`/tmp/${i}.png`);
    await handle.finalize('正文');

    const cards = deliveredCards();
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) expect(requestBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_MAX_BYTES);
    expect(markdownContent(cards[0])).toBe('正文');
    const imageKeys = cards.flatMap((card) =>
      cardElements(card).filter((element) => element.tag === 'img').map((element) => element.img_key),
    );
    expect(imageKeys).toHaveLength(200);
    expect(new Set(imageKeys).size).toBe(200);
  });

  // Regression for PR #6817: start/finalize must edit the existing message.
  // Unit tier; the previous tests asserted fresh delivery and missed recall notices.
  it('sends the full final only as a fallback when updating the original card fails', async () => {
    const handle = await start('ou_owner', 'working', { threadTs: 'om_root' });
    mocks.patchCardRaw.mockRejectedValueOnce(new Error('patch unavailable'));
    await handle.finalize('正文');
    await handle.finalize('正文');
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_stream', expect.anything());
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(2);
    expect(markdownContent(mocks.sendCardRaw.mock.calls[1][1])).toBe('正文');
    expect(mocks.sendCardRaw.mock.calls[1][2]).toEqual({ threadTs: 'om_root', advanceRound: false });
    expect(handle.messageId).toBe('om_final');
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('edits progress and then the final on the same card, only once', async () => {
    vi.useFakeTimers();
    try {
      const handle = await start('ou_owner', 'working', { threadTs: 'om_root' });
      handle.append('draft');
      await vi.advanceTimersByTimeAsync(1500);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('draft');
      handle.replace('pending draft');
      await handle.finalize('answer');
      await handle.finalize('answer');
      await vi.advanceTimersByTimeAsync(1500);
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
      expect(mocks.patchCardRaw.mock.calls.map(([id]) => id)).toEqual(['om_stream', 'om_stream']);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe('answer');
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
      expect(mocks.recallMessage).not.toHaveBeenCalled();
      expect(handle.messageId).toBe('om_stream');
    } finally { vi.useRealTimers(); }
  });

  it('waits for an in-flight progress edit before writing the final answer', async () => {
    vi.useFakeTimers();
    try {
      let finishProgress!: () => void;
      mocks.patchCardRaw.mockImplementationOnce(() => new Promise<void>((resolve) => { finishProgress = resolve; }));
      const handle = await start('ou_owner');
      handle.append('draft');
      await vi.advanceTimersByTimeAsync(1500);
      const finished = handle.finalize('answer');
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(1);
      finishProgress();
      await finished;
      expect(mocks.patchCardRaw).toHaveBeenCalledTimes(2);
      expect(markdownContent(mocks.patchCardRaw.mock.calls[1][1])).toBe('answer');
      expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
      expect(mocks.recallMessage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('updates a claimed opener without recalling it or resetting its reply anchor', async () => {
    mocks.claimPatchableOpener.mockReturnValueOnce('om_opener');
    const handle = await start('g/oc_chat/omt_topic');
    await handle.finalize('answer');
    expect(mocks.patchCardRaw).toHaveBeenCalledExactlyOnceWith('om_opener', expect.anything());
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toBe('answer');
    expect(mocks.sendCardRaw).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
    expect(mocks.rearmAnchorToTrigger).not.toHaveBeenCalled();
    expect(handle.messageId).toBe('om_opener');
  });

  it('does not send a fallback through a replacement account after a failed final edit', async () => {
    const handle = await start('ou_owner');
    mocks.patchCardRaw.mockImplementationOnce(async () => {
      mocks.getAccountEpoch.mockReturnValue(2);
      throw new Error('old account disconnected');
    });
    await handle.finalize('answer');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  it('does not send or recall through a replacement account after image upload', async () => {
    mocks.uploadImage.mockImplementation(async () => {
      mocks.getAccountEpoch.mockReturnValue(2);
      return 'img_old_account';
    });
    const handle = await start('ou_owner');
    handle.addExtraImageAbsPath?.('/tmp/image.png');
    await handle.finalize('answer');
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(mocks.patchCardRaw).not.toHaveBeenCalled();
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });

  it('sends a delivery notice if both final editing and fallback delivery fail', async () => {
    mocks.patchCardRaw.mockRejectedValue(new Error('card patch unavailable'));
    const handle = await start('ou_owner');
    mocks.sendCardRaw.mockRejectedValueOnce(new Error('send unavailable'));
    await handle.finalize('正文');

    expect(mocks.sendText).toHaveBeenCalledWith(
      'ou_owner',
      messages.streaming.deliveryFailed,
      undefined,
    );
  });

  it('still finalizes a streaming card when an inline image upload throws', async () => {
    const absPath = '/cindy-media/missing.png';
    mocks.resolveMediaUrl.mockReturnValue(absPath);
    mocks.uploadImage.mockRejectedValue(new Error('file gone'));
    const handle = await start('g/oc_group/omt_topic');

    await expect(
      handle.finalize('终态正文 ![坏](xdt-image://blob/missing.png)'),
    ).resolves.toBeUndefined();

    expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
    expect(mocks.sendCardRaw).toHaveBeenCalledTimes(1);
    expect(markdownContent(mocks.patchCardRaw.mock.calls[0][1])).toContain('终态正文');
    expect(mocks.recallMessage).not.toHaveBeenCalled();
  });
});
