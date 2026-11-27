import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { InputHandoffService } from '../service.js';
import { buildTerminalPromptStep } from '../terminalPrompt.js';

describe('terminal prompt card', () => {
  it('maps common prompts to the right standard field', () => {
    const field = (prompt: string, program: 'sudo' | 'ssh' | 'git' = 'ssh') =>
      buildTerminalPromptStep(prompt, program).controls[0];
    expect(field('[sudo] password for someone:', 'sudo')).toMatchObject({ kind: 'text', contentType: 'password' });
    expect(field("Enter passphrase for key '/Users/someone/.ssh/id_ed25519':")).toMatchObject({ contentType: 'password' });
    expect(field('(someone@host) Verification code:')).toMatchObject({ contentType: 'one-time-code' });
    expect(field("Username for 'https://git.example':", 'git')).toMatchObject({ contentType: 'username' });
  });

  it('shows where a git credential goes and warns about plain http', () => {
    expect(buildTerminalPromptStep("Password for 'https://someone@git.example':", 'git').source)
      .toEqual({ app: 'git', origin: 'https://git.example' });
    expect(buildTerminalPromptStep("Password for 'http://git.example':", 'git').source)
      .toEqual({ app: 'git', origin: 'http://git.example', warning: 'insecure' });
  });

  it('asks for a typed yes / no for an unknown ssh host key', () => {
    const step = buildTerminalPromptStep('Are you sure you want to continue connecting (yes/no/[fingerprint])?', 'ssh');
    expect(step.controls).toEqual([expect.objectContaining({ kind: 'text', contentType: 'text', placeholder: 'yes / no' })]);
  });
});

const services: InputHandoffService[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.cleanupAll());
  vi.useRealTimers();
});

function harness() {
  const snapshots: InputHandoffSnapshot[] = [];
  const continued: string[] = [];
  const service = new InputHandoffService({
    broadcast: (_channel, payload) => {
      const request = (payload as { request?: InputHandoffSnapshot }).request;
      if (request) snapshots.push(request);
    },
    createDriver: () => null,
    hostPid: 1,
    remoteInputAvailable: () => true,
    continueAgent: async (_s, _r, message) => { continued.push(message); },
    terminalRetentionMs: 0,
  });
  services.push(service);
  const answers: Array<string | null> = [];
  const ask = (sessionId = 'task', prompt = '[sudo] password for someone:') => service.startTerminalPrompt({
    sessionId, prompt, program: 'sudo', command: 'sudo -A true', answer: (value) => answers.push(value),
  });
  return { service, snapshots, continued, answers, ask, latest: () => snapshots[snapshots.length - 1] };
}

describe('terminal prompt handoff', () => {
  // #9276 review, unit: existing card tests did not cancel the waiting MCP call
  // or share its budget across cards. Late answers must never reach Main.
  it('closes host input on caller cancellation and rejects a late secret', async () => {
    const h = harness();
    const controller = new AbortController();
    h.service.startHostSecretPrompt({ sessionId: 'task', signal: controller.signal, step: {
      purpose: 'API key', source: { app: 'Cindy' }, controls: [{ id: 'answer', kind: 'text', label: 'Key', contentType: 'password' }],
    }, answer: value => h.answers.push(value) });
    const snapshot = h.latest();
    controller.abort();
    expect(h.answers).toEqual([null]);
    expect(h.latest()).toMatchObject({ terminal: true, phase: 'cancelled' });
    expect(await h.service.submit(snapshot.requestId, { expectedRevision: snapshot.revision,
      values: { answer: 'late-key' }, action: { kind: 'submit' } }, { deviceId: 'phone-1' })).toBe(false);
    expect(h.answers).toEqual([null]);
    expect(h.continued).toEqual([]);
  });
  it('expires successive host input cards at the original call deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    const deadline = Date.now() + 9 * 60_000;
    const ask = () => h.service.startHostSecretPrompt({ sessionId: 'task', deadline, step: {
      purpose: 'API key', source: { app: 'Cindy' }, controls: [{ id: 'answer', kind: 'text', label: 'Key', contentType: 'password' }],
    }, answer: value => h.answers.push(value) });
    ask();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    const first = h.latest();
    expect(await h.service.submit(first.requestId, { expectedRevision: first.revision,
      values: { answer: 'first-key' }, action: { kind: 'submit' } }, { deviceId: 'phone-1' })).toBe(true);
    expect(ask().ok).toBe(true);
    const second = h.latest();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.answers).toEqual(['first-key', null]);
    expect(h.latest()).toMatchObject({ terminal: true, phase: 'expired' });
    expect(await h.service.submit(second.requestId, { expectedRevision: second.revision,
      values: { answer: 'late-key' }, action: { kind: 'submit' } }, { deviceId: 'phone-1' })).toBe(false);
  });
  // Unit: host credentials must use the existing sealed submission/holder flow,
  // even without a desktop driver. Terminal-only coverage did not exercise this entry.
  it('delivers a host API key only to Main, with origin and no fake terminal command', async () => {
    const h = harness();
    h.service.startHostSecretPrompt({ sessionId: 'task', step: {
      purpose: 'Example API key', source: { app: 'Cindy', origin: 'https://example.test' },
      controls: [{ id: 'answer', kind: 'text', label: 'API key', contentType: 'password' }],
    }, answer: value => h.answers.push(value) });
    const snapshot = h.latest();
    expect(snapshot).toMatchObject({ remoteInput: true, source: { app: 'Cindy', origin: 'https://example.test' } });
    expect(snapshot.command).toBeUndefined();
    const submission = { expectedRevision: snapshot.revision, values: { answer: 'synthetic-api-key' }, action: { kind: 'submit' as const } };
    expect(await h.service.submit(snapshot.requestId, submission, { deviceId: 'phone-1' })).toBe(true);
    expect(h.answers).toEqual(['synthetic-api-key']);
    expect(JSON.stringify(h.snapshots)).not.toContain('synthetic-api-key');
    expect(h.continued).toEqual([]);
  });
  it('gives the typed answer to the program only, and the agent gets no message', async () => {
    const h = harness();
    const started = h.ask();
    expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(h.latest()?.phase).toBe('ready'));
    expect(h.latest()).toMatchObject({ command: 'sudo -A true', source: { app: 'sudo' } });

    const ok = await h.service.submit(h.latest().requestId, {
      expectedRevision: h.latest().revision,
      values: { answer: 'synthetic-pass' },
      action: { kind: 'submit' },
    }, { deviceId: 'phone-1' });
    expect(ok).toBe(true);
    expect(h.answers).toEqual(['synthetic-pass']);
    expect(h.latest().phase).toBe('succeeded');
    expect(JSON.stringify(h.snapshots)).not.toContain('synthetic-pass');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.continued).toEqual([]);
  });

  it('fails the program when the owner cancels', async () => {
    const h = harness();
    h.ask();
    await vi.waitFor(() => expect(h.latest()?.phase).toBe('ready'));
    h.service.resolve(h.latest().requestId, { kind: 'input_handoff', action: 'cancel', expectedRevision: h.latest().revision });
    await vi.waitFor(() => expect(h.answers).toEqual([null]));
  });

  it('ends quietly when the program stops waiting', async () => {
    const h = harness();
    const started = h.ask();
    await vi.waitFor(() => expect(h.latest()?.phase).toBe('ready'));
    if (started.ok) started.abandon?.();
    expect(h.latest()).toMatchObject({ phase: 'failed', failure: 'target_gone', terminal: true });
    expect(h.answers).toEqual([]);
  });
});
