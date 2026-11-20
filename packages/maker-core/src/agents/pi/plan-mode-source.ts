import { PI_PLAN_TODOS_SOURCE } from './plan-todos-source.js';

export const CINDY_PLAN_MODE_EXTENSION_FILENAME = 'cindy-plan-mode.ts';

/** Keep the installed, version-matched native extension as the behavior owner. */
export function buildPiPlanModeExtensionSource(nativePath: string): string {
  return `import nativePlan from ${JSON.stringify(nativePath.replace(/\\/g, '/'))};\n`
    + PI_PLAN_TODOS_SOURCE + PI_PLAN_MODE_ADAPTER_SOURCE;
}

// The array synchronization approach is adapted from zcinta0514's #8976.
// Only the bundled extension receives this API; other extensions are untouched.
const PI_PLAN_MODE_ADAPTER_SOURCE = String.raw`
export default function cindyPlanMode(pi) {
  let state;
  let pending;
  function numberedList(message) {
    return typeof message === 'string' ? message.replace(/^(\d+)\. /gm, (line, ordinal) => {
      const item = state?.todos?.[Number(ordinal) - 1];
      return item ? item.step + '. ' : line;
    }) : message;
  }
  nativePlan(new Proxy(pi, {
    get(target, key) {
      if (key === 'appendEntry') return (type, data) => {
        if (type === 'plan-mode') {
          state = data;
          // Native parsing can replace its closed-over array. Correct that very
          // array before persistence, confirmation and execution consume it.
          if (pending && data.enabled && !data.executing && Array.isArray(data.todos)) {
            data.todos.splice(0, data.todos.length, ...pending.todos);
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
              return (message, ...rest) => ui.notify(numberedList(message), ...rest);
            },
          }),
        }) });
      };
      if (key === 'sendMessage') return (message, options) => {
        if (message.customType === 'plan-todo-list') {
          // The following execution message already includes the full plan.
          // Queueing the native summary separately can start an extra turn
          // before the execution instruction is consumed (Pi 1.0 and 1.5).
          if (pending) return;
          message = { ...message, content: numberedList(message.content) };
        }
        if (message.customType === 'plan-mode-execute' && pending) {
          // Preserve every detail, including text outside the numbered titles.
          message = { ...message, content: 'Execute the plan in full:\n\n' + pending.plan
            + (pending.wholePlan ? '\n\nAfter completing the entire plan, include [DONE:1] to complete its single tracked item. The numbers inside the plan are not tracking ids.'
              : '\n\nAfter completing a step, include a [DONE:n] tag using its original number.') };
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
                const index = entries.findLastIndex(entry => entry.type === 'custom' && entry.customType === 'plan-mode');
                // Native --plan does not append an initial entry. Supply a
                // private array for its closure so an all-short first plan can
                // reach native confirmation rather than returning early.
                const entry = index >= 0 ? entries[index] : undefined;
                state = { ...(entry?.data ?? { enabled: pi.getFlag('plan') === true }),
                  todos: Array.isArray(entry?.data?.todos) ? entry.data.todos.map(item => ({ ...item })) : [] };
                const restored = { type: 'custom', customType: 'plan-mode', ...entry, data: state };
                return index >= 0 ? entries.map((item, i) => i === index ? restored : item) : [...entries, restored];
              };
            },
          }),
        }));
        if (eventName !== 'agent_end') return target.on(eventName, handler);
        return target.on(eventName, async (event, ctx) => {
          const assistant = [...event.messages].reverse().find(message => message.role === 'assistant');
          const plan = Array.isArray(assistant?.content) ? selectPlanText(assistant.content) : '';
          if (state?.enabled && !state.executing && ctx.hasUI && plan.trim()
            && assistant?.stopReason !== 'error' && assistant?.stopReason !== 'aborted'
            && Array.isArray(state.todos)) {
            const todos = extractTodoItems(plan);
            pending = { plan, wholePlan: todos.length === 0,
              todos: todos.length ? todos : [{ step: 1, text: plan, completed: false }] };
            state.todos.splice(0, state.todos.length, ...pending.todos);
          }
          try { return await handler(event, ctx); }
          finally { pending = undefined; }
        });
      };
    },
  }));
}
`;
