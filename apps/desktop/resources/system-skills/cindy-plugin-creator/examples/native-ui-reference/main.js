/* Minimal author example. Configuration UI and persistence belong to plugins. */
(() => {
  const ui = cindy.ui;
  const formats = new Map(); // Example-only state, cleared when this runtime stops.
  const validTask = id => typeof id === 'string' && id.length > 0 && id.length <= 256;
  const current = sessionId => formats.get(sessionId) ?? 'plain';
  cindy.onHostMessage(message => {
    if (message.type !== 'tool-call') return;
    const sessionId = message.args?.session_context?.session_id;
    if (message.tool !== 'preview' || !validTask(sessionId)) {
      void cindy.send({ type: 'tool-result', callId: message.callId, ok: false, message: 'Preview context unavailable' });
      return;
    }
    const format = current(sessionId), text = String(message.args.text ?? '').slice(0, 4000);
    void cindy.send({ type: 'tool-result', callId: message.callId, ok: true,
      result: { format, preview: format === 'markdown' ? `# Preview\n\n${text}` : text } });
  });
  if (ui) void ui.capabilities().then(capabilities => {
    if (capabilities.tabViews) for (const [id, point, view, label] of [
      ['open-log', 'session.header.actions', 'build-log', '打开构建日志'],
      ['open-preview', 'message.actions', 'result-preview', '打开结果预览'],
    ]) {
      if (!capabilities.points.includes(point)) continue;
      ui.contribute(id, {
        render() {
          return { controls: [{ kind: 'button', id: 'open', label, actionId: 'open' }],
            blocks: [], actions: [{ id: 'open', label }], fallbackMarkdown: label };
        },
        onAction({ actionId, context }) {
          if (actionId !== 'open') return { status: 'rejected' };
          return { status: 'completed', openView: { id: view, params: {
            buildId: context.scope.kind === 'message' ? context.scope.messageClientId : 'example-17',
          } } };
        },
      });
    }
    if (capabilities.points.includes('composer.tools')) ui.contribute('output-format', {
      render(context) {
        const format = current(context.scope.sessionId);
        return { controls: [{ kind: 'select', id: 'format', label: 'Output format', value: format,
          actionId: 'set-format', options: [{ value: 'plain', label: 'Plain' }, { value: 'markdown', label: 'Markdown' }] }],
          blocks: [], actions: [{ id: 'set-format', label: 'Change format' }], fallbackMarkdown: `Output format: ${format}` };
      },
      onAction({ actionId, values, context }) {
        if (actionId !== 'set-format' || !validTask(context.scope.sessionId) || !['plain', 'markdown'].includes(values.format))
          return { status: 'rejected' };
        formats.set(context.scope.sessionId, values.format);
        ui.invalidate({ contributionId: 'output-format', scope: context.scope });
        if (capabilities.points.includes('session.statusbar')) ui.invalidate({ contributionId: 'format-status', scope: context.scope });
        return { status: 'completed' };
      },
    });
    if (capabilities.points.includes('session.statusbar')) ui.contribute('format-status', {
      render(context) {
        const label = `Output: ${current(context.scope.sessionId)} · Switch`;
        return { controls: [{ kind: 'button', id: 'format', label, actionId: 'toggle-format' }],
          blocks: [], actions: [{ id: 'toggle-format', label: 'Switch format' }], fallbackMarkdown: label };
      },
      onAction({ actionId, context }) {
        if (actionId !== 'toggle-format' || !validTask(context.scope.sessionId)) return { status: 'rejected' };
        formats.set(context.scope.sessionId, current(context.scope.sessionId) === 'plain' ? 'markdown' : 'plain');
        ui.invalidate({ contributionId: 'format-status', scope: context.scope });
        ui.invalidate({ contributionId: 'output-format', scope: context.scope });
        return { status: 'completed' };
      },
    });
  }).catch(() => {}); // UI is optional; the original preview tool remains usable.
})();
