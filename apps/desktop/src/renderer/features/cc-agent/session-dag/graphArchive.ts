import type { DagCanvasState, DagNode } from './types';

export type GraphArchiveInput = {
  nodes: DagNode[];
  originalNodes?: DagNode[];
  labels: Record<string, string>;
  selectedVersions?: Readonly<Record<string, string>>;
  canvasState?: DagCanvasState;
};

/** Export visible, attributable turns, not executable engine transcripts or pending drafts. */
export function graphArchive(input: GraphArchiveInput, format: 'jsonl' | 'html'): string {
  const { nodes, labels, canvasState, selectedVersions } = input;
  const originals = new Map((input.originalNodes ?? nodes).map((n) => [n.id, n]));
  const index = new Map(nodes.map((n, i) => [n.id, i + 1]));
  const revisions = new Map<string, DagCanvasState['revisions']>();
  for (const rev of canvasState?.revisions ?? []) {
    const group = revisions.get(rev.nodeId);
    if (group) group.push(rev);
    else revisions.set(rev.nodeId, [rev]);
  }
  const turns = nodes.map((n) => {
    const original = originals.get(n.id) ?? n;
    return {
      type: 'turn',
      id: n.id,
      parentId: n.parentId,
      side: !!n.side,
      label: labels[n.id] ?? '',
      original: { question: original.question, answer: original.answer },
      selected: {
        version: selectedVersions?.[n.id] || 'origin',
        question: n.question,
        answer: n.answer,
      },
      revisions: revisions.get(n.id) ?? [],
      position: canvasState?.positions[n.id],
      ...(canvasState?.sizes?.[n.id] && { size: canvasState.sizes[n.id] }),
      ...(canvasState?.summaries?.[n.id] && { summary: canvasState.summaries[n.id] }),
    };
  });
  const references = (canvasState?.references ?? []).filter(
    (r) => index.has(r.fromNodeId) && index.has(r.toNodeId),
  );
  if (format === 'jsonl')
    return (
      [
        { type: 'graph', format: 'cindy-session-dag', version: 1 },
        ...turns,
        ...references.map((r) => ({
          type: 'reference',
          ...(r.includedInQuestion && { includedInQuestion: true }),
          source: r.toNodeId,
          target: r.fromNodeId,
          snapshot: r.snapshot,
          createdAt: r.createdAt,
        })),
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );
  const esc = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );
  const link = (id: string) => `<a href="#turn-${index.get(id)}">第 ${index.get(id)} 轮</a>`;
  const cards = turns
    .map(
      (n, i) =>
        `<article id="turn-${i + 1}"><header>第 ${i + 1} 轮${n.parentId && index.has(n.parentId) ? `　继承自 ${link(n.parentId)}` : ''}${n.side ? '　旁问' : ''}${n.label ? `　${esc(n.label)}` : ''}${n.summary ? `　${esc(n.summary)}` : ''}</header><h2>${esc(n.selected.question)}</h2><small>${n.selected.version === 'origin' ? '原答' : '手动修订'}</small><pre>${esc(n.selected.answer)}</pre>${n.revisions.length ? `<details><summary>原文与手动修订记录</summary><h3>原文</h3><pre>${esc(n.original.question)}\n${esc(n.original.answer)}</pre>${n.revisions.map((r, j) => `<h3>手动修订 ${j + 1}</h3><pre>${esc(r.question)}\n${esc(r.answer)}</pre>`).join('')}</details>` : ''}</article>`,
    )
    .join('');
  const sources = references
    .map(
      (r) =>
        `<li>${link(r.fromNodeId)} 引用 ${link(r.toNodeId)}<pre>${esc(r.snapshot.question)}\n${esc(r.snapshot.summary)}</pre></li>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>会话图</title><style>:root{color-scheme:light dark}body{max-width:54rem;margin:auto;padding:1rem;font:1rem/1.6 system-ui,sans-serif}article{border-block-start:1px solid GrayText;padding-block:1rem}pre,h2{white-space:pre-wrap;overflow-wrap:anywhere}pre{font:inherit}header,small{color:GrayText}</style><main><h1>会话图</h1>${cards}${sources ? `<section><h2>已确认的引用快照</h2><ul>${sources}</ul></section>` : ''}</main></html>`;
}
