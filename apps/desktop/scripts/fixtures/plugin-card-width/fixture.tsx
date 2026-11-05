import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { GhostToolCard } from '../../../src/renderer/components/chat/GhostToolCard';

const content = `<section style="padding:16px;border:1px solid var(--border-default);border-radius:12px;color:var(--text-primary);font-size:16px;line-height:1.6">
<div data-ghost-width="full"><strong>Review completed</strong></div>
${Array.from({ length: 5 }, () => '<p style="margin:12px 0">The review report follows the available message width. Resize the conversation to read the complete result and keep the action below the report visible.</p>').join('')}
<button type="button" data-ghost-action="refresh" style="padding:8px 12px;border:1px solid var(--border-default);border-radius:8px;color:inherit;background:transparent">Refresh</button></section>`;

const overflowContent = `<style>body{overflow:visible}</style>
<div data-ghost-width="full" style="height:120px;color:var(--text-primary)">
<div style="height:300px;display:flex;flex-direction:column;justify-content:space-between">
<p>Content extends beyond its authored container height.</p>
<button type="button" data-ghost-action="refresh">Refresh</button></div></div>`;

void mountPage({
  host: {
    ghosts: {
      listSync: () => ({ ghosts: [] }),
      onChanged: subscription('ghostsChanged'),
      onCardUpdated: subscription('cardUpdated'),
      reportCardHeight: async () => ({ ok: true }),
      dispatchCardAction: forbid('ghosts.dispatchCardAction'),
    },
  },
  render: ctx => <main style={{ padding: 12 }}>
    <div data-card-container style={{ width: '100%', maxWidth: '100%' }}>
      <GhostToolCard callId="width-fixture" ghostId="Example plugin" toolName="review" toolInput={{}}
        html={ctx.case === 'overflow' ? overflowContent : ctx.case === 'poster' ? content.replace(' data-ghost-width="full"', '') : content}
        animatedHtml={ctx.case === 'animated' ? content.replace(' data-ghost-width="full"', '') : undefined}
        height={700} running={ctx.case === 'animated'} />
    </div>
  </main>,
});
