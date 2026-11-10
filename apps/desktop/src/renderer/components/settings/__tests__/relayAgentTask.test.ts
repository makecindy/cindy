import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { buildRelayAgentPrompt, createRelayAgentTask } from '../relayAgentTask';
import en from '@/i18n/locales/en/common.json';
import type { SelfHostedRelayDeploymentView } from '../../../../shared/selfHostedRelay';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/sessionService', () => ({ create }));

// Unit: the new settings entry must create an ordinary local task without borrowing a user's
// unsent draft or remote authority. Existing relay fixtures cover fixed-install commands only.
// Smallest failing cases: an existing home draft, or account change while task creation awaits.
describe('relay Agent task handoff', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'relay-task' });
    setDataOwnerGeneration('owner');
    clearDraft('relay-task');
    clearDraft(NEW_MAKER_DRAFT_KEY);
  });

  it('opens a separate local task with editable instructions and preserves the home draft', async () => {
    const original = { text: plainTextToTiptapDoc('My unfinished work'), attachments: [], pendingGhostId: 'my-plugin' };
    saveDraft(NEW_MAKER_DRAFT_KEY, original);
    expect(await createRelayAgentTask('My relay', 'Deploy on my server')).toBe('relay-task');
    expect(create).toHaveBeenCalledWith({ title: 'My relay', workspaceKind: 'dialogue' });
    expect(getDraft('relay-task')).toMatchObject({ text: plainTextToTiptapDoc('Deploy on my server'), attachments: [] });
    expect(getDraft(NEW_MAKER_DRAFT_KEY)).toEqual(original);
  });

  it('does not place another account’s instructions in the current owner’s draft store', async () => {
    create.mockImplementation(async () => {
      setDataOwnerGeneration('another-owner');
      return { id: 'relay-task' };
    });
    expect(await createRelayAgentTask('My relay', 'Private deployment context')).toBeNull();
    expect(getDraft('relay-task')).toBeUndefined();
  });

  it('propagates task creation failure instead of leaving a successful-looking draft', async () => {
    create.mockRejectedValue(new Error('Model unavailable'));
    await expect(createRelayAgentTask('My relay', 'Deploy')).rejects.toThrow('Model unavailable');
    expect(getDraft('relay-task')).toBeUndefined();
  });

  it('carries only the selected host or exact existing relay identity into the request', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const t = i18n.t.bind(i18n);
    const host = { id: 'existing-alias', hostname: 'server.example', user: 'deploy' };
    const chosen = buildRelayAgentPrompt(t, 'deploy', { host });
    expect(JSON.parse(chosen.slice(chosen.indexOf('{')))).toEqual({ sshHostId: host.id, host: host.hostname, user: host.user });
    expect(buildRelayAgentPrompt(t, 'deploy')).not.toContain('existing-alias');
    const deployment = { relayId: 'existing-relay', deploymentKey: 'my-server', name: 'My server' } as SelfHostedRelayDeploymentView;
    for (const action of ['resume', 'upgrade', 'remove'] as const) {
      const prompt = buildRelayAgentPrompt(t, action, { deployment });
      expect(prompt.startsWith(en.settings.remoteControl.relay.agent.prompt[action])).toBe(true);
      expect(JSON.parse(prompt.slice(prompt.indexOf('{')))).toEqual(deployment);
    }
  });
});
