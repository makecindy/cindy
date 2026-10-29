import { youtubeVideo } from '../richAnswer';
import { describe, expect, it } from 'vitest';
import { RichAnswerStream, RichInteractionMemory, hasRichAnswer, splitRichAnswer, richDefaults, richEvaluate, richLabel, richResolvedValues, richChart, richCalculationUnavailable, richVisualStyle, richVector, richLinePlot, richMediaSource, type RichPalette } from '../richAnswer';
// Tier 1: actual stream reducer. Regression targets are partial transport, edits,
// replay and preservation of user input; no DOM/source-string contracts.
const line = (seq: number, op: Record<string, unknown>) => JSON.stringify({ seq, ...op }) + '\n';
describe('streaming answer documents', () => {
  it('commits complete operations before the closing fence without exposing partial protocol', () => {
    const first = line(1, { op: 'create', id: 'title', kind: 'heading', props: { text: '你好' } });
    const second = line(2, { op: 'append', id: 'title', text: '，世界' });
    const parser = new RichAnswerStream();
    const input = 'Introduction\n```cindy-ui\n' + first + second;
    for (let length = 0; length <= input.length; length++) {
      const parts = splitRichAnswer(input.slice(0, length));
      const part = parts.find(p => p.kind === 'rich');
      if (!part) continue;
      const doc = parser.update(part.source, part.complete);
      const expected = length >= input.length ? '你好，世界' : length >= input.length - second.length ? '你好' : undefined;
      expect(doc.nodes.get('title')?.props.text).toBe(expected);
      expect(doc.issues).toBe(0);
    }
    expect(hasRichAnswer('```cindy-ui')).toBe(true);
    expect(hasRichAnswer('````markdown\n```cindy-ui\n{}\n```\n````')).toBe(false);
  });
  it('replays source snapshots, ignores duplicate operations and never mutates earlier snapshots', () => {
    const create = line(1, { op: 'create', id: 'a', kind: 'text', props: { text: 'one' } });
    const append = line(2, { op: 'append', id: 'a', text: ' two' });
    const parser = new RichAnswerStream(), first = parser.update(create);
    const next = parser.update(create + append + append);
    expect(next.nodes.get('a')?.props.text).toBe('one two');
    expect(first.nodes.get('a')?.props.text).toBe('one');
    expect(new RichAnswerStream().update(create + append).nodes).toEqual(next.nodes);
    expect(parser.update(create).nodes.get('a')?.props.text).toBe('one');
  });
  it.each([false, true])('recovers a prematurely finalized partial operation when the full snapshot arrives (newline=%s)', (newline) => {
    const heading = line(1, { op: 'create', id: 'title', kind: 'heading', props: { text: 'Results' } });
    const answer = line(2, { op: 'create', id: 'answer', kind: 'markdown', props: { text: 'Complete findings' } });
    const full = heading + (newline ? answer : answer.trimEnd());
    const parser = new RichAnswerStream();
    const partial = parser.update(heading + answer.slice(0, -8), true);
    expect(partial.roots).toEqual(['title']);
    expect(partial.issues).toBe(1);
    // Identical snapshots must not count the unfinished tail as another error.
    expect(parser.update(heading + answer.slice(0, -8), true).issues).toBe(1);
    const recovered = parser.update(full, true);
    expect(recovered.roots).toEqual(['title', 'answer']);
    expect(recovered.nodes.get('answer')?.props.text).toBe('Complete findings');
    expect(recovered.issues).toBe(0);
    expect(recovered.nodes).toEqual(new RichAnswerStream().update(full, true).nodes);
    expect(partial.roots).toEqual(['title']);
    expect(partial.nodes.has('answer')).toBe(false);
  });
  it('preserves a valid finalized tail and applies later operations exactly once', () => {
    const create = line(1, { op: 'create', id: 'answer', kind: 'text', props: { text: 'one' } }).trimEnd();
    const append = line(2, { op: 'append', id: 'answer', text: ' two' });
    const parser = new RichAnswerStream();
    const first = parser.update(create, true);
    const full = create + String.fromCharCode(10) + append;
    const next = parser.update(full, true);
    expect(next.nodes.get('answer')?.props.text).toBe('one two');
    expect(next.issues).toBe(0);
    expect(parser.update(full, true).nodes.get('answer')?.props.text).toBe('one two');
    expect(first.nodes.get('answer')?.props.text).toBe('one');
  });
  it.each(['create', 'append', 'patch'])('preserves a committed %s tail when malformed suffixes keep growing', (operation) => {
    const create = line(1, { op: 'create', id: 'answer', kind: 'text', props: { text: 'one' } });
    const update = operation === 'create' ? create.trimEnd() : create + line(2, operation === 'append'
      ? { op: 'append', id: 'answer', text: ' two' }
      : { op: 'patch', id: 'answer', props: { text: 'one two' } }).trimEnd();
    const expected = operation === 'create' ? 'one' : 'one two';
    const parser = new RichAnswerStream();
    const committed = parser.update(update, true);
    for (const suffix of ['{', '{"seq":', '{"seq":3']) {
      const next = parser.update(update + suffix, true);
      expect(next.nodes.get('answer')?.props.text).toBe(expected);
      expect(next.roots).toEqual(['answer']);
      expect(next.issues).toBeGreaterThan(0);
    }
    const prefix = update + '{"seq":3' + String.fromCharCode(10);
    const beforeRecovery = parser.update(prefix, true);
    const later = line(operation === 'create' ? 2 : 3, { op: 'create', id: 'later', kind: 'text', props: { text: 'Later' } });
    parser.update(prefix + later.slice(0, -8), true);
    const recovered = parser.update(prefix + later, true);
    expect(recovered.nodes.get('answer')?.props.text).toBe(expected);
    expect(recovered.nodes.get('later')?.props.text).toBe('Later');
    expect(recovered.issues).toBe(beforeRecovery.issues);
    expect(committed.nodes.get('answer')?.props.text).toBe(expected);
  });
  it('preserves committed content when an extended finalized tail exceeds the source limit', () => {
    const create = line(1, { op: 'create', id: 'answer', kind: 'text', props: { text: 'Readable' } }).trimEnd();
    const parser = new RichAnswerStream();
    parser.update(create, true);
    const rejected = parser.update(create + ' '.repeat(2_000_001), true);
    expect(rejected.nodes.get('answer')?.props.text).toBe('Readable');
    expect(rejected.issues).toBe(1);
    const recovered = parser.update(create + String.fromCharCode(10), true);
    expect(recovered.nodes.get('answer')?.props.text).toBe('Readable');
    expect(recovered.issues).toBe(0);
  });
  it('retains genuine malformed-line issues after an unfinished tail recovers', () => {
    const prefix = 'invalid' + String.fromCharCode(10);
    const answer = line(1, { op: 'create', id: 'answer', kind: 'text', props: { text: 'Readable' } });
    const parser = new RichAnswerStream();
    expect(parser.update(prefix + answer.slice(0, -8), true).issues).toBe(2);
    expect(parser.update(prefix + answer.slice(0, -8) + ' '.repeat(2_000_001), true).issues).toBe(2);
    const recovered = parser.update(prefix + answer, true);
    expect(recovered.nodes.get('answer')?.props.text).toBe('Readable');
    expect(recovered.issues).toBe(1);
  });
  it('keeps user-edited state while model defaults and calculated data change', () => {
    const parser = new RichAnswerStream(), memory = new RichInteractionMemory();
    const source = line(1, { op: 'create', id: 'months', kind: 'range', props: { default: 6 } }) + line(2, { op: 'create', id: 'cost', kind: 'stat', props: { value: { op: 'mul', args: [{ ref: 'months' }, 10] } } });
    let doc = parser.update(source);
    memory.set('owner/device/message', { months: 9 });
    doc = parser.update(source + line(3, { op: 'patch', id: 'months', props: { default: 12 } }));
    const values = { ...richDefaults(doc), ...memory.get('owner/device/message') };
    expect(richLabel(doc.nodes.get('cost')!, values)).toBe('90');
    expect(memory.get('other-owner/device/message')).toEqual({});
    expect(richEvaluate({ op: 'div', args: [1, 0] }, values)).toBeUndefined();
  });
  it('moves and removes subtrees and isolates invalid updates from existing readable content', () => {
    const ops = [
      { op: 'create', id: 'group', kind: 'stack' },
      { op: 'create', id: 'text', kind: 'text', parent: 'group', props: { text: 'Readable' } },
      { op: 'move', id: 'group', parent: 'group' },
      { op: 'move', id: 'text', parent: 'root' },
      { op: 'remove', id: 'group' },
    ];
    const doc = new RichAnswerStream().update(ops.map((op, i) => line(i + 1, op)).join(''));
    expect(doc.roots).toEqual(['text']);
    expect(doc.nodes.get('text')?.props.text).toBe('Readable');
    expect(doc.issues).toBe(1);
  });
  it('commits later operations after a malformed or skipped sequence instead of orphaning them', () => {
    // Real-world regression (session 3c876950): one unescaped quote in a props.text
    // used to reject every following line via the strict +1 gate, dropping 9 of 13 ops.
    const heading = (seq: number, id: string) => line(seq, { op: 'create', id, kind: 'heading', props: { text: id } });
    const malformed = '{"seq":3,"op":"create","id":"bad","kind":"markdown","props":{"text":"记了"注入"缺陷"}}\n';
    const doc = new RichAnswerStream().update(heading(1, 'a') + heading(2, 'b') + malformed + heading(4, 'c') + heading(5, 'd'));
    expect(doc.roots).toEqual(['a', 'b', 'c', 'd']);
    expect(doc.nodes.has('bad')).toBe(false);
    expect(doc.issues).toBe(2); // the malformed line itself + the skipped sequence 3
    const skipped = new RichAnswerStream().update(heading(1, 'a') + heading(3, 'c') + heading(4, 'd'));
    expect(skipped.roots).toEqual(['a', 'c', 'd']);
    expect(skipped.issues).toBe(1);
  });
});
it('restores persisted controls without overwriting input entered during a slow load', async () => {
  let release!: (value: string | null) => void;
  let persisted = '';
  const memory = new RichInteractionMemory({
    read: () => new Promise(resolve => { release = resolve; }),
    write: async value => { persisted = value; },
  });
  const loading = memory.load();
  memory.set('owner/device/message', { months: 9 });
  release(JSON.stringify({ version: 1, entries: [['owner/device/message', { months: 2, enabled: true }]] }));
  await loading;
  expect(memory.get('owner/device/message')).toEqual({ months: 9, enabled: true });
  await memory.flush();
  const restored = new RichInteractionMemory({ read: async () => persisted, write: async () => {} });
  await restored.load();
  expect(restored.get('owner/device/message')).toEqual({ months: 9, enabled: true });
});

// Tier 1: a real Claude comparison referenced calculated stat IDs. Previously
// totals were right but the winner, savings and chart silently treated them as zero.
it('resolves calculated references and updates dependent labels and charts after input', () => {
  const source = [
    { id: 'months', kind: 'range', props: { default: 6 } },
    { id: 'extra', kind: 'check', props: { default: false } },
    { id: 'saving', kind: 'stat', props: { value: { op: 'sub', args: [{ ref: 'monthly' }, { ref: 'yearly' }] } } },
    { id: 'monthly', kind: 'stat', props: { value: { op: 'mul', args: [{ ref: 'months' }, { op: 'if', args: [{ ref: 'extra' }, 25, 20] }] } } },
    { id: 'yearly', kind: 'stat', props: { value: { op: 'add', args: [180, { op: 'if', args: [{ ref: 'extra' }, { op: 'mul', args: [5, { ref: 'months' }] }, 0] }] } } },
    { id: 'winner', kind: 'text', props: { value: { op: 'if', args: [{ op: 'gt', args: [{ ref: 'saving' }, 0] }, 'yearly', 'monthly'] } } },
    { id: 'chart', kind: 'chart', props: { data: [{ label: 'Monthly', value: { ref: 'monthly' } }, { label: 'Yearly', value: { ref: 'yearly' } }] } },
  ].map((node, i) => line(i + 1, { op: 'create', ...node })).join('');
  const doc = new RichAnswerStream().update(source, true);
  const initial = richResolvedValues(doc);
  expect(richLabel(doc.nodes.get('winner')!, initial)).toBe('monthly');
  const edited = richResolvedValues(doc, { months: 12, extra: true });
  expect(richLabel(doc.nodes.get('saving')!, edited)).toBe('60');
  expect(richLabel(doc.nodes.get('winner')!, edited)).toBe('yearly');
  expect(richChart(doc.nodes.get('chart')!, edited).map(x => x.value)).toEqual([300, 240]);
});
it('keeps missing, cyclic and invalid calculations unavailable instead of reporting zero', () => {
  const source = line(1, { op: 'create', id: 'a', kind: 'stat', props: { value: { ref: 'b' } } });
  const parser = new RichAnswerStream();
  let doc = parser.update(source);
  expect(richCalculationUnavailable(doc.nodes.get('a')!, richResolvedValues(doc))).toBe(true);
  doc = parser.update(source + line(2, { op: 'create', id: 'b', kind: 'stat', props: { value: { ref: 'a' } } }));
  expect(richLabel(doc.nodes.get('a')!, richResolvedValues(doc))).toBe('—');
  doc = parser.update(source + line(2, { op: 'create', id: 'b', kind: 'stat', props: { value: 25 } }));
  expect(richLabel(doc.nodes.get('a')!, richResolvedValues(doc))).toBe('25');
  expect(richEvaluate({ op: 'add', args: ['', 2] }, {})).toBeUndefined();
  expect(richEvaluate({ op: 'concat', args: Array(32).fill({ ref: 'text' }) }, { text: 'a'.repeat(4096) })).toBeUndefined();
});

const palette: RichPalette = { primary: "P", secondary: "S", tertiary: "T", success: "OK", warning: "W", danger: "D", border: "B" };
// Tier 1: model visual attributes must reach both renderers without admitting
// executable SVG/URL payloads; the reported stock data must not flatten at zero.
it("maps color roles, keeps vector geometry, excludes executable attributes, and fits line domains", () => {
  const source = line(1, {
    op: "create",
    id: "visual",
    kind: "svg",
    props: {
      style: {
        color: "secondary",
        fontSize: 28,
        gap: 24,
        backgroundColor: "url(https://example.test/track)",
      },
      viewBox: [0, 0, 400, 240],
      shapes: [
        {
          type: "path",
          d: "M 0 20 L 40 30",
          stroke: "success",
          fill: "none",
          strokeWidth: 4,
          onClick: "alert(1)",
        },
        { type: "script", text: "alert(1)" },
        { type: "image", href: "file:///private" },
        { type: "text", x: 20, y: 40, text: "Model label", fill: "#1257ab" },
      ],
    },
  });
  const doc = new RichAnswerStream().update(source, true),
    node = doc.nodes.get("visual")!;
  expect(doc.issues).toBe(0);
  expect(richVisualStyle(node, palette)).toEqual({
    color: "S",
    fontSize: 28,
    gap: 24,
  });
  const vector = richVector(node, palette);
  expect(vector.viewBox).toBe("0 0 400 240");
  expect(vector.shapes).toHaveLength(2);
  expect(vector.shapes[0].props).toEqual({
    d: "M 0 20 L 40 30",
    stroke: "OK",
    fill: "none",
    strokeWidth: 4,
  });
  const data = [
    23972.29, 24040.34, 24280.56, 24130.5, 23785.79, 24213.55, 24271.2,
    24345.22, 24314.17, 24062.72, 24186.83,
  ].map((value, i) => ({ label: String(i), value }));
  const plot = richLinePlot(data, 640);
  expect(plot.min).toBeGreaterThan(23000);
  expect(plot.max).toBeGreaterThan(24345.22);
  expect(plot.showValues).toBe(false);
  const chosen = richLinePlot(data, 640, {
    yMin: 23000,
    yMax: 25000,
    height: 300,
    ticks: 6,
    showValues: true,
  });
  expect(chosen).toMatchObject({
    min: 23000,
    max: 25000,
    height: 300,
    showValues: true,
  });
  expect(chosen.ticks).toHaveLength(6);
});

// Tier 1: small-valued series used to round every axis label to zero; mobile
// nested charts also need x labels sampled independently of point annotations.
it("keeps small-valued axes distinguishable and dense dates on the same coordinate system", () => {
  const plot = richLinePlot(
    Array.from({ length: 11 }, (_, i) => ({
      label: `10/${i + 2}`,
      value: 0.00001 + i * 0.000001,
    })),
    300,
  );
  expect(new Set(plot.ticks.map((t) => t.label)).size).toBe(plot.ticks.length);
  expect(plot.labels.length).toBeLessThan(plot.points.length);
  expect(
    plot.labels.every((t) =>
      plot.points.some((p) => p.x === t.x && p.label === t.label),
    ),
  ).toBe(true);
  expect(
    richLinePlot([{ label: "a", value: 24000 }], 300, { includeZero: true })
      .min,
  ).toBeLessThanOrEqual(0);
});

// Unit: RFC 3986 schemes are case-insensitive. Existing media coverage missed
// case normalization; only the scheme may change, and unsafe schemes stay denied.
it.each([
  ['HTTPS://Example.test/Media/Image.PNG?Token=Aa%2Bb#Preview', 'https://Example.test/Media/Image.PNG?Token=Aa%2Bb#Preview'],
  ['CINDY-MEDIA://blobs/AbC123.PNG?Token=Aa%2Bb#Preview', 'cindy-media://blobs/AbC123.PNG?Token=Aa%2Bb#Preview'],
])('normalizes only the allowed scheme in %s', (src, expected) => {
  expect(richMediaSource({ id: 'media', kind: 'image', props: { src }, children: [] })).toBe(expected);
});
it.each(['JaVaScRiPt:alert(1)', 'DaTa:text/html;base64,PHNjcmlwdD4='])('rejects unsafe media scheme %s', src => {
  expect(richMediaSource({ id: 'media', kind: 'image', props: { src }, children: [] })).toBeNull();
});

// Unit: the reported YouTube watch URL used to reach the file player. Existing
// media tests cover file URLs only; verify host routing and the navigation boundary.
it('routes YouTube pages to canonical players without turning arbitrary URLs into embeds', () => {
  for (const src of ['https://www.youtube.com/watch?v=glW1pXWebnY', 'https://youtu.be/glW1pXWebnY', 'https://m.youtube.com/shorts/glW1pXWebnY']) {
    const video = youtubeVideo(src)!;
    expect(video.id).toBe('glW1pXWebnY');
    expect(video.embed).toBe('https://www.youtube.com/embed/glW1pXWebnY?playsinline=1&autoplay=0');
  }
  expect(youtubeVideo('https://youtu.be/glW1pXWebnY?t=1m2s')?.embed).toContain('start=62');
  for (const src of ['https://youtube.com.evil.test/watch?v=glW1pXWebnY', 'https://evil@www.youtube.com/watch?v=glW1pXWebnY', 'file:///watch?v=glW1pXWebnY', 'https://example.org/movie.mp4', 'https://youtube.com/watch?v=bad']) expect(youtubeVideo(src)).toBeNull();
  expect(youtubeVideo('https://www.youtube-nocookie.com/embed/glW1pXWebnY?autoplay=1')?.embed).toBe('https://www.youtube.com/embed/glW1pXWebnY?playsinline=1&autoplay=0');
});
// 2026-10-18 owner decision: colors and backgrounds belong to Cindy. Answers written
// before it (and literal colors from models) must not paint backgrounds or custom colors.
it("ignores model backgrounds and color values and keeps borders on the host border", () => {
  const card = new RichAnswerStream().update(
    line(1, { op: "create", id: "card", kind: "stack", props: { style: { backgroundColor: { light: "#14161b", dark: "#101216" }, color: { light: "#f5f6f8", dark: "#f5f6f8" }, borderColor: "#2a2e36", borderWidth: 3, padding: 20 } } }),
    true,
  ).nodes.get("card")!;
  expect(richVisualStyle(card, palette)).toEqual({ padding: 20, borderWidth: 1, borderStyle: "solid", borderColor: "B" });
  expect(richVisualStyle(card)).toEqual({ padding: 20, borderWidth: 1 });
});

// Unit: new explicit send protocol. Existing local-state tests cannot detect a
// message duplicated on double-click/remount or an invalid expression submitted.
it('resolves only bounded message text and keeps local actions independent', async () => {
  const { richSendText, richAction } = await import('../richAnswer');
  const node = { id: 'send', kind: 'button' as const, children: [], props: {
    send: { op: 'concat', args: ['Plan: ', { ref: 'choice' }] },
    set: { choice: 'local' },
  } };
  expect(richSendText(node, { choice: 'Park' })).toBe('Plan: Park');
  expect(richSendText(node, {})).toBeUndefined();
  for (const send of ['', '   ', false, { op: 'execute', args: ['bad'] }, 'x'.repeat(16001)])
    expect(richSendText({ ...node, props: { send } }, {})).toBeUndefined();
  expect(richAction(node, {})).toEqual({ choice: 'local' });
});

it('holds an in-flight submission across remounts and restores accepted receipts', async () => {
  const { RichSubmissionController } = await import('../richAnswer');
  let persisted = '';
  const storage = { read: async () => persisted, write: async (v: string) => { persisted = v; } };
  const memory = new RichInteractionMemory(storage), controller = new RichSubmissionController(memory);
  let finish!: (accepted: boolean) => void;
  const messages: string[] = [];
  const send = (text: string) => { messages.push(text); return new Promise<boolean>(resolve => { finish = resolve; }); };
  const first = controller.submit('owner:message:send', 'Plan: Park', send);
  await memory.load();
  await Promise.resolve();
  await controller.submit('owner:message:send', 'Plan: Park', send);
  expect(controller.status('owner:message:send', 'Plan: Park')).toBe('sending');
  expect(messages).toEqual(['Plan: Park']);
  finish(true); await first;
  const restored = new RichSubmissionController(new RichInteractionMemory(storage));
  await restored.submit('owner:message:send', 'Plan: Park', send);
  expect(messages).toEqual(['Plan: Park']);
  expect(restored.status('owner:message:send', 'Plan: Park')).toBe('sent');
  expect(restored.status('owner:message:send', 'Plan: Museum')).toBe('idle');
  expect(restored.status('other-owner:message:send', 'Plan: Park')).toBe('idle');
});

it('lets the user retry a refused submission without consuming field values', async () => {
  const { RichSubmissionController } = await import('../richAnswer');
  const memory = new RichInteractionMemory(), controller = new RichSubmissionController(memory);
  memory.set('fields', { choice: 'Park' });
  await controller.submit('receipt', 'Park', async () => false);
  expect(controller.status('receipt', 'Park')).toBe('failed');
  expect(memory.get('fields')).toEqual({ choice: 'Park' });
  await controller.submit('receipt', 'Park', async () => true);
  expect(controller.status('receipt', 'Park')).toBe('sent');
});


// #7627: two near-miss drafts models keep writing. Both used to drop the whole
// node (or all of its text) and leave only the "part of this content was hidden" line.
describe('malformed node drafts stay readable', () => {
  it('keeps the text of a node whose props is a plain string', () => {
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'b', kind: 'text', props: '这一行会消失' }),
    );
    expect(doc.issues).toBe(0);
    expect(doc.nodes.get('b')?.props.text).toBe('这一行会消失');
  });
  it('turns inline children of a details node into child nodes', () => {
    const doc = new RichAnswerStream().update(
      line(1, {
        op: 'create',
        id: 'd',
        kind: 'details',
        props: { label: '折叠块', children: [{ kind: 'markdown', text: '正文' }] },
      }),
    );
    const details = doc.nodes.get('d');
    expect(doc.issues).toBe(0);
    expect(details?.props.children).toBeUndefined();
    expect(details?.children).toHaveLength(1);
    const child = doc.nodes.get(details?.children[0] ?? '');
    expect(child?.kind).toBe('markdown');
    expect(child?.props.text).toBe('正文');
  });
});
describe('inline draft limits', () => {
  it('caps nested inline drafts at the depth limit', () => {
    let nested: Record<string, unknown> = { kind: 'markdown', text: 'deepest' };
    for (let level = 0; level < 40; level++) nested = { kind: 'stack', children: [nested] };
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'd', kind: 'details', props: { label: '折叠块', children: [nested] } }),
    );
    expect(doc.nodes.size).toBeLessThanOrEqual(32);
    expect(doc.nodes.get('d')?.children).toHaveLength(1);
    // 被深度上限截掉的子树属于「没能显示出来的内容」, 不能让 issues 保持 0。
    expect(doc.issues).toBeGreaterThan(0);
  });
  it('skips one unreadable inline draft without losing its siblings', () => {
    const doc = new RichAnswerStream().update(
      line(1, {
        op: 'create',
        id: 'd',
        kind: 'details',
        props: {
          label: '折叠块',
          children: [
            { kind: 'markdown', text: '第一段' },
            { kind: 'text', props: 123 },
            { kind: 'markdown', text: '第二段' },
          ],
        },
      }),
    );
    const details = doc.nodes.get('d');
    expect(details?.children).toHaveLength(2);
    const texts = (details?.children ?? []).map((id) => doc.nodes.get(id)?.props.text);
    expect(texts).toEqual(['第一段', '第二段']);
    expect(doc.issues).toBe(1);
  });
});
describe('inline draft ids', () => {
  it('limits string props by the size of the node it becomes', () => {
    const quoted = '"'.repeat(65_535);
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'q', kind: 'text', props: quoted }),
    );
    // 原始字符串没超限, 但存下来的是 {text: ...}, 序列化后翻倍越过上限。
    expect(doc.nodes.get('q')).toBeUndefined();
    expect(doc.issues).toBe(1);
    const plain = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'p', kind: 'text', props: 'a'.repeat(30_000) }),
    );
    expect(plain.nodes.get('p')?.props.text).toHaveLength(30_000);
  });
  it('keeps generated ids inside the eighty character grammar', () => {
    const parentId = 'p'.repeat(79);
    const drafts = Array.from({ length: 1001 }, (_, i) => ({ kind: 'markdown', text: `第${i}段` }));
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: parentId, kind: 'details', props: { label: '折叠块', children: drafts } }),
    );
    const children = doc.nodes.get(parentId)?.children ?? [];
    expect(children).toHaveLength(1001);
    expect(new Set(children).size).toBe(1001);
    for (const id of children) expect(id.length).toBeLessThanOrEqual(80);
    expect(doc.issues).toBe(0);
  });
});

// #7627 review: a draft that names itself keeps that id, and a bare string only
// counts as text for the kinds that render `props.text`.
describe('inline draft ids and text-only props', () => {
  it('keeps an inline child id that the draft declares', () => {
    const doc = new RichAnswerStream().update(
      line(1, {
        op: 'create',
        id: 'tabs',
        kind: 'details',
        props: {
          label: 'x',
          children: [
            { id: 'second', kind: 'markdown', text: 'two' },
            { kind: 'markdown', text: 'three' },
          ],
        },
      }),
    );
    expect(doc.issues).toBe(0);
    expect(doc.nodes.get('tabs')?.children[0]).toBe('second');
  });

  it('keeps a string props on the kinds that render text from it', () => {
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'm', kind: 'math', props: 'E = mc^2' }),
    );
    expect(doc.issues).toBe(0);
    expect(doc.nodes.get('m')?.props.text).toBe('E = mc^2');
  });
  it('drops a string props on a kind that never reads text', () => {
    const doc = new RichAnswerStream().update(
      line(1, { op: 'create', id: 'd', kind: 'details', props: 'plain string' }),
    );
    expect(doc.nodes.has('d')).toBe(false);
    expect(doc.issues).toBe(1);
  });
});
