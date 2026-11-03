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
afterEach(() => services.splice(0).forEach((s) => s.cleanupAll()));

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
