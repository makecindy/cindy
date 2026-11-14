import { PI_PLAN_TODOS_SOURCE } from './plan-todos-source.js';

/** Adapt only the bundled plan extension; third-party dialogs keep native semantics. */
export const CINDY_PLAN_REVIEW_TITLE = 'cindy:plan-review';
export const CINDY_PLAN_REVIEW_EXTENSION_FILENAME = 'cindy-plan-review.ts';

export function buildPiPlanReviewExtensionSource(nativePath: string): string {
  const modulePath = nativePath.replace(/\\/g, '/');
  return `import nativePlan from ${JSON.stringify(modulePath)};\n`
    + PI_PLAN_TODOS_SOURCE
    + CINDY_PLAN_REVIEW_ADAPTER_SOURCE;
}

// Runs inside Pi. Delegate tool restrictions, /plan, persistence and progress to
// the version-matched upstream extension, without changing its installed files.
const CINDY_PLAN_REVIEW_ADAPTER_SOURCE = String.raw`
export default function cindyPlanReview(pi) {
  let state;
  let approvedPlan;
  let pendingTodos;
  nativePlan(new Proxy(pi, {
    get(target, key) {
      if (key === 'appendEntry') return (type, data) => {
        if (type === 'plan-mode') {
          state = data;
          // Native agent_end may replace the array with its own lossy parser's
          // output. Correct that same array before it is persisted or reviewed.
          if (data.enabled && !data.executing && pendingTodos && Array.isArray(data.todos)) {
            data.todos.splice(0, data.todos.length, ...pendingTodos);
          }
        }
        return target.appendEntry(type, data);
      };
      if (key === 'registerCommand') return (name, command) => {
        if (name !== 'todos') return target.registerCommand(name, command);
        return target.registerCommand(name, { ...command, handler: (args, ctx) => command.handler(args, {
          ...ctx, ui: new Proxy(ctx.ui, {
            get(ui, method) {
              if (method !== 'notify') return Reflect.get(ui, method);
              return (message, ...rest) => ui.notify(typeof message === 'string'
                ? message.replace(/^(\d+)\. /gm, (line, ordinal) => {
                  const item = state?.todos?.[Number(ordinal) - 1];
                  return item ? item.step + '. ' : line;
                }) : message, ...rest);
            },
          }),
        }) });
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
        if (eventName === 'session_start') return target.on(eventName, (event, ctx) => handler(event, {
          ...ctx, sessionManager: new Proxy(ctx.sessionManager, {
            get(manager, method) {
              if (method !== 'getEntries') return Reflect.get(manager, method);
              return (...args) => {
                const entries = manager.getEntries(...args);
                state = entries.filter(entry => entry.type === 'custom' && entry.customType === 'plan-mode').pop()?.data;
                return entries;
              };
            },
          }),
        }));
        if (eventName !== 'agent_end') return target.on(eventName, handler);
        return target.on(eventName, async (event, ctx) => {
          const assistant = [...event.messages].reverse().find(message => message.role === 'assistant');
          const plan = Array.isArray(assistant?.content)
            ? assistant.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
            : '';
          if (state?.enabled && !state.executing && plan.trim()
            && assistant?.stopReason !== 'error' && assistant?.stopReason !== 'aborted'
            && Array.isArray(state.todos)) {
            const todos = extractTodoItems(plan);
            pendingTodos = todos.length ? todos : [{ step: 1, text: plan, completed: false }];
            // Seed the native closure as well: an all-short/unparsed first plan
            // otherwise returns before appendEntry or the review UI is reached.
            state.todos.splice(0, state.todos.length, ...pendingTodos);
          }
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
                      : [{ step: 1, text: approvedPlan, completed: false }]));
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
          finally { approvedPlan = undefined; pendingTodos = undefined; }
        });
      };
    },
  }));
}
`;
