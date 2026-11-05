/** Adapt only the bundled plan extension; third-party dialogs keep native semantics. */
export const CINDY_PLAN_REVIEW_TITLE = 'cindy:plan-review';
export const CINDY_PLAN_REVIEW_EXTENSION_FILENAME = 'cindy-plan-review.ts';

export function buildPiPlanReviewExtensionSource(nativePath: string): string {
  const modulePath = nativePath.replace(/\\/g, '/');
  const utilsPath = modulePath.slice(0, modulePath.lastIndexOf('/') + 1) + 'utils.ts';
  return `import nativePlan from ${JSON.stringify(modulePath)};\n`
    + `import { extractTodoItems } from ${JSON.stringify(utilsPath)};\n`
    + CINDY_PLAN_REVIEW_ADAPTER_SOURCE;
}

// Runs inside Pi. Delegate tool restrictions, /plan, persistence and progress to
// the version-matched upstream extension, without changing its installed files.
const CINDY_PLAN_REVIEW_ADAPTER_SOURCE = String.raw`
export default function cindyPlanReview(pi) {
  let state;
  let approvedPlan;
  nativePlan(new Proxy(pi, {
    get(target, key) {
      if (key === 'appendEntry') return (type, data) => {
        if (type === 'plan-mode') state = data;
        return target.appendEntry(type, data);
      };
      if (key === 'sendMessage') return (message, options) => {
        // The plan card already contains the full plan. A separate follow-up
        // containing only native step titles can start a turn before the approved
        // text (Pi 1.0), so never queue that redundant summary.
        if (message.customType === 'plan-todo-list') return;
        if (message.customType === 'plan-mode-execute' && approvedPlan) {
          message = { ...message, content: 'Execute the approved plan in full:\n\n' + approvedPlan
            + '\n\nAfter completing a step, include a [DONE:n] tag in your response.' };
        }
        return target.sendMessage(message, options);
      };
      if (key !== 'on') return Reflect.get(target, key);
      return (eventName, handler) => {
        if (eventName !== 'agent_end') return target.on(eventName, handler);
        return target.on(eventName, async (event, ctx) => {
          const assistant = [...event.messages].reverse().find(message => message.role === 'assistant');
          const plan = Array.isArray(assistant?.content)
            ? assistant.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
            : '';
          let feedback;
          const ui = new Proxy(ctx.ui, {
            get(nativeUi, method) {
              // This proxy is visible ONLY to the bundled extension's agent_end
              // handler. No title/option heuristic can approve another extension.
              if (method === 'select') return async (_title, choices) => {
                if (!plan.trim() || assistant?.stopReason === 'error' || assistant?.stopReason === 'aborted') return undefined;
                const raw = await nativeUi.input('cindy:plan-review', JSON.stringify({ plan }));
                let result;
                try { result = JSON.parse(raw || '{}'); } catch { return undefined; }
                if (result.action === 'implement' && typeof result.plan === 'string' && result.plan.trim()) {
                  approvedPlan = result.plan;
                  // Upstream retains this array in its closure. Keep its tracker
                  // aligned with edits; the full plan remains execution authority.
                  if (Array.isArray(state?.todos)) {
                    const todos = extractTodoItems(approvedPlan);
                    state.todos.splice(0, state.todos.length, ...(todos.length ? todos
                      : [{ step: 1, text: 'Implement the approved plan', completed: false }]));
                  }
                  return choices[0];
                }
                if (result.action === 'revise' && typeof result.feedback === 'string' && result.feedback.trim()) {
                  feedback = result.feedback;
                  return choices[2];
                }
                return undefined;
              };
              if (method === 'editor') return async () => feedback;
              return Reflect.get(nativeUi, method);
            },
          });
          try { return await handler(event, { ...ctx, ui }); }
          finally { approvedPlan = undefined; }
        });
      };
    },
  }));
}
`;
