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
    'Tools: get_workspace_info, create_worker, create_workers, send_to_worker.';
  const explicitCreationBoundary =
    'Use create_worker only when the user explicitly asks to open one new worker, and use create_workers only when the user explicitly asks to open multiple new workers.';
  const missingWorkerBoundary =
    'If no existing worker matches a requested role or label, say so and ask whether to create one; do not silently substitute another worker or a native subagent.';

  it('routes explicit Worker assignments through Orca before considering native subagents', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(workerRoutingRule);
    expect(prompt).toContain(nativeSubagentBoundary);
    expect(prompt).toContain('Codex: spawn_agent; Claude Code: the Agent/Task tool');
    expect(prompt).not.toContain('followup_task');
    expect(prompt.indexOf(workerRoutingRule)).toBeLessThan(prompt.indexOf(nativeSubagentBoundary));
  });

  it('requires execution-channel disclosure and terminal-state verification', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(
      'Show the native subagent identifier, assigned task, and actual terminal status',
    );
    expect(prompt).toContain(
      'A native subagent result is not evidence that an Orca Worker ran or completed.',
    );
    expect(prompt).toContain(channelDisclosureRule);
  });

  it('declares create_workers across the visible tool surface and turn-ending rules', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(toolSurfaceRule);
    expect(prompt).toContain(
      'When you call create_worker, create_workers, or send_to_worker, the task is sent to the worker asynchronously.',
    );
    expect(prompt).toContain(
      'After create_worker, create_workers, or send_to_worker returns, your turn is OVER.',
    );
    expect(prompt).toContain(
      'After calling create_worker, create_workers, or send_to_worker, your turn ENDS immediately.',
    );
  });

  it('distinguishes reuse from explicit worker creation and forbids silent fallback', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(explicitCreationBoundary);
    expect(prompt).toContain(missingWorkerBoundary);
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
    'If the user asks for a "subagent" / "子代理", use your native subagent mechanism (Codex: spawn_agent; Claude Code: the Agent/Task tool) to handle it yourself — do NOT escalate to the lead for it, and do NOT call start_team / create_worker (you cannot create Orca workers).';

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

  it('keeps the subagent routing hint with worker identity metadata', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain('worker_id=worker-1');
    expect(prompt).toContain(subagentHint);
  });
});
