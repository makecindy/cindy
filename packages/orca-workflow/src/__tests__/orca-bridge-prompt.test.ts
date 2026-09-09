import { describe, expect, it } from 'vitest';

import { renderOrcaLeadSystemPrompt, renderOrcaWorkerSystemPrompt } from '../orca-bridge-prompt.js';

describe('renderOrcaLeadSystemPrompt', () => {
  const workerRoutingRule =
    'An assignment to an Orca Worker MUST use the Orca tools below.';
  const nativeSubagentBoundary =
    'only when the user explicitly asks for a "subagent" / "子代理" without assigning the task to an Orca Worker';
  const channelDisclosureRule =
    'label every delegated task with its actual execution channel: Orca Worker or native subagent.';
  const toolSurfaceRule =
    'Tools: get_workspace_info, create_worker, create_workers, send_to_worker, interrupt_worker, get_worker_queue_status, update_queued_message, cancel_queued_message, merge_queued_messages.';
  const explicitCreationBoundary =
    'Use create_worker only when the user explicitly asks to open one new worker, and use create_workers only when the user explicitly asks to open multiple new workers.';
  const missingWorkerBoundary =
    'If no existing worker matches a requested role or label, say so and ask whether to create one; do not silently substitute another worker or a native subagent.';
  const missingGenericWorkerBoundary =
    'If the user assigns a task to a generic Orca Worker but no worker exists, say so and ask whether to create one; the assignment itself is not authorization to create it.';
  const multiRoleReadinessBoundary =
    'For a multi-role request, resolve every requested role or label before dispatching any task; if any target is missing or its creation approval is unresolved, dispatch nothing, report all missing targets, and ask first.';
  const multiRoleBatchBoundary =
    'For a fully resolved multi-role request, issue every required Orca dispatch in one parallel tool-call batch';
  const sendDispatchSignals =
    'Treat send_to_worker as dispatched only when its payload has ok=true and wake_kind=resumed, already-active, or queued.';
  const createDispatchSignals =
    'Treat create_worker, and each created result from create_workers, as dispatched only when it has dispatched=true, a queued_message_id, or dispatch_outcome.kind=session-dispatch with dispatch_outcome.dispatched=true (including dispatch_outcome.wakeKind=queued).';
  const interruptDispatchSignals =
    'Treat interrupt_worker as dispatched only when its payload has ok=true and queued_message_id; stop_outcome reports the graceful-stop result and never means the replacement was dropped.';
  const batchResultRule =
    'After a multi-role tool-call batch returns, always relay create_workers.user_report verbatim when present, summarize every create_workers per-item result or error, and report every other failed/no-dispatch tool result.';

  it('routes explicit Worker assignments through Orca before considering native subagents', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(workerRoutingRule);
    expect(prompt).toContain(nativeSubagentBoundary);
    expect(prompt).toContain('for example Codex spawn_agent, or the Claude Code Agent/Task tool');
    expect(prompt).not.toContain('followup_task');
    expect(prompt.indexOf(workerRoutingRule)).toBeLessThan(prompt.indexOf(nativeSubagentBoundary));
  });

  it('forbids substituting an Orca Worker for a subagent or improvising one', () => {
    // Orca Worker 是 session 级协同者，subagent 是 agent 内部的一次性执行体；
    // 两者不可互换，也不允许自己起进程冒充任一执行通道。
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain('An Orca Worker is NEVER a substitute for a subagent.');
    expect(prompt).toContain('Do NOT open or reuse an Orca Worker to satisfy a subagent request');
    expect(prompt).toContain('do NOT improvise one by spawning processes yourself');
    expect(prompt).not.toContain('If you have no native subagent mechanism');
  });

  it('requires execution-channel disclosure and terminal-state verification', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(
      'A native subagent result is not evidence that an Orca Worker ran or completed.',
    );
    expect(prompt).toContain(channelDisclosureRule);
    expect(prompt).not.toContain(
      'Show the native subagent identifier, assigned task, and actual terminal status',
    );
  });

  it('keeps native subagent lifecycle tools away from Orca Workers', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain('Orca Workers are not native subagents');
    expect(prompt).toContain('native subagent lifecycle tools');
    expect(prompt).toContain('wait_agent or equivalents');
    expect(prompt).toContain('wait for or manage Orca Workers');
    expect(prompt).toContain('Orca reports arrive automatically as new messages');
    expect(prompt).toContain(
      'Use those lifecycle tools only for native subagents that the user explicitly requested',
    );
    expect(prompt).toContain('If other Orca Workers are still working, do not wait for them');
    expect(prompt).not.toContain('/simplify');
  });

  it('preserves async delivery, terminal routing, and emergency diagnostics boundaries', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(
      '(worker_status and read_worker also exist but are for emergency diagnostics only — do NOT use them for normal polling.)',
    );
    expect(prompt).toContain(
      'You will be automatically woken up when the worker responds — you do NOT need to check on it.',
    );
    expect(prompt).toContain(
      'For a single-role request, after create_worker, send_to_worker, or interrupt_worker returns with the concrete dispatch signals above, your turn is OVER. Produce ZERO output',
    );
    expect(prompt).toContain(
      'Produce the final summary only after every relevant task has a terminal result from its own execution channel (rule 8).',
    );
  });

  it('declares create_workers while preserving batch result reporting boundaries', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(toolSurfaceRule);
    expect(prompt).toContain(sendDispatchSignals);
    expect(prompt).toContain(createDispatchSignals);
    expect(prompt).toContain(interruptDispatchSignals);
    expect(prompt).toContain(batchResultRule);
    expect(prompt).toContain(multiRoleBatchBoundary);
    expect(prompt).toContain(
      'send_to_worker for existing targets, create_worker for exactly one authorized new target, and one create_workers call for 2+ authorized new targets.',
    );
    expect(prompt).toContain(
      'If any task has the concrete dispatch signals above, end the turn immediately after that single combined result report.',
    );
    expect(prompt).toContain(
      'If every task dispatched and no create_workers report is required, produce ZERO output.',
    );
    expect(prompt).not.toContain(
      'After create_worker, create_workers, or send_to_worker returns, your turn is OVER.',
    );
    expect(prompt).not.toContain(
      'After calling create_worker, create_workers, or send_to_worker, your turn ENDS immediately.',
    );
  });

  it('reports failed or no-dispatch tool results instead of waiting for a worker wake-up', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(
      'If create_worker, send_to_worker, or interrupt_worker fails or lacks those dispatch signals, report the result immediately instead of ending silently.',
    );
    expect(prompt).toContain(
      'Silence is tied to the concrete dispatch signals above, not merely to calling a tool.',
    );
    expect(prompt).toContain(
      'For a fully resolved multi-role request, issue all required Orca dispatches together in the one parallel tool-call batch described above',
    );
    expect(prompt).not.toContain('when the tool result says a task was accepted or queued');
  });

  it('distinguishes reuse from explicit worker creation and forbids silent fallback', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(explicitCreationBoundary);
    expect(prompt).toContain(missingWorkerBoundary);
    expect(prompt).toContain(missingGenericWorkerBoundary);
    expect(prompt).toContain(multiRoleReadinessBoundary);
  });

  it('states the queue inspection, atomic interrupt, and atomic merge rules verbatim', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(
      'Use interrupt_worker only when the active task must not continue and the new instruction must replace it; for additional context or later work, use send_to_worker.',
    );
    expect(prompt).toContain(
      'If get_workspace_info shows queued_count > 0 or queue_paused=true, call get_worker_queue_status first, then revise or withdraw one pending message, merge related messages, or send a separate task.',
    );
    expect(prompt).toContain(
      'Never simulate an interrupt or merge with multiple stop, update, cancel, or send calls because the queue may advance between calls.',
    );
  });

  it('keeps Worker routing and disclosure rules when an initial worker exists', () => {
    const prompt = renderOrcaLeadSystemPrompt({ workerId: 'worker-1', sessionId: 'session-1' });

    expect(prompt).toContain(workerRoutingRule);
    expect(prompt).toContain(toolSurfaceRule);
    expect(prompt).toContain(channelDisclosureRule);
  });
});

describe('renderOrcaWorkerSystemPrompt', () => {
  const subagentHint =
    'If the user asks for a "subagent" / "子代理", use your own native subagent mechanism (for example Codex spawn_agent, or the Claude Code Agent/Task tool) to handle it yourself — do NOT escalate to the lead for it, and do NOT call start_team / create_worker (you cannot create Orca workers). An Orca Worker is never a substitute for a subagent.';
  const workerSubagentReportingBoundary =
    'If you use native subagents, have them return findings only to you. Never tell them to contact the Lead or call send_to_lead; aggregate their results and report to the Lead yourself.';

  const workerMeta = {
    workerId: 'worker-1',
    sessionId: 'session-1',
    workflowId: 'workflow-1',
    leadSessionId: 'lead-1',
  };

  it('adds the subagent routing hint for workers', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain(subagentHint);
  });

  it('keeps native subagent reporting with the Orca Worker', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);
    expect(prompt).toContain(workerSubagentReportingBoundary);
    expect(prompt).toContain('3. ALWAYS call send_to_lead when complete or blocked.');
    expect(prompt).toContain('4. Report once; do not send progress updates.');
    expect(prompt).toContain('10. If the user asks for a "subagent" / "子代理"');
    expect(prompt.indexOf('3. ALWAYS call send_to_lead')).toBeLessThan(
      prompt.indexOf(workerSubagentReportingBoundary),
    );
    expect(prompt.indexOf(workerSubagentReportingBoundary)).toBeLessThan(
      prompt.indexOf('4. Report once; do not send progress updates.'),
    );
  });

  it('keeps the subagent routing hint with worker identity metadata', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain('worker_id=worker-1');
    expect(prompt).toContain(subagentHint);
  });

  it('keeps the Worker rule concise without the unreachable fallback', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain('An Orca Worker is never a substitute for a subagent');
    expect(prompt).not.toContain('If you have no native subagent mechanism');
    expect(prompt).not.toContain(
      'Show the native subagent identifier, assigned task, and actual terminal status',
    );
  });
});
