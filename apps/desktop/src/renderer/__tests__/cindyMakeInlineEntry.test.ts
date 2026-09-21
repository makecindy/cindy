import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composer = readFileSync(resolve(__dirname, '../components/new-chat/ChatInput.tsx'), 'utf8');
const sessionView = readFileSync(
  resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);

describe('Cindy Make composer presentation', () => {
  it('opens preflight in place and only routes standalone diagnostics to their container', () => {
    expect(composer).toContain('<CindyMakePreflightDialog');
    expect(composer).toContain("makeResult.kind === 'preflight'");
    expect(composer).toContain('setMakePreflight({');
    expect(composer).toContain('else if (makeResult.sessionId !== sourceSessionId)');
  });

  it('keeps question, plan and permission prompts ahead of the first-execution input lock', () => {
    const promptHost = sessionView.indexOf('<InteractionPromptHost');
    const mask = sessionView.indexOf('<CindyMakeComposerMask');
    const input = sessionView.indexOf('<ChatInput', mask);
    expect(promptHost).toBeGreaterThan(-1);
    expect(mask).toBeGreaterThan(promptHost);
    expect(input).toBeGreaterThan(mask);
    const interactionGuard = sessionView.slice(
      sessionView.indexOf('</InteractionPromptHost>'),
      mask,
    );
    expect(interactionGuard).toMatch(
      /pendingPlanReview ||[\s\S]*pendingPermission ||[\s\S]*pendingAskUser/,
    );
    expect(interactionGuard).toContain('pendingGhostGrantConfirm ? null');
    expect(sessionView).toContain('if (cindyMakeInputLocked) return false;');
    expect(sessionView).not.toContain('CindyMakeResumeCard');
    const recovery = sessionView.indexOf(') : cindyMakeRecoveryId && session ? (');
    expect(recovery).toBeGreaterThan(mask);
    expect(recovery).toBeLessThan(input);
    expect(sessionView.slice(recovery, input)).toContain('<CindyMakeTestCard');
    expect(sessionView.slice(recovery, input)).toContain(') : (');
  });
});
