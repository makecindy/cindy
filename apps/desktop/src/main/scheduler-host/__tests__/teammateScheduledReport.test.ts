import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeammateScheduledReportPublisher } from '../teammateScheduledReport.desktop.js';
import { botProfiles, messages, sessions } from '../../localDb/schema.js';

const fakes = vi.hoisted(() => ({
  resolveProject: vi.fn(),
  resolveCanonical: vi.fn(),
  isShadowed: vi.fn(),
  getDb: vi.fn(),
  createMessage: vi.fn(),
  markAttention: vi.fn(),
}));
vi.mock('../ownTeammateProject.js', () => ({ resolveOwnTeammateProject: fakes.resolveProject }));
vi.mock('../../maker-ipc/botCanonicalSessionRegistry.js', () => ({ resolveBotCanonicalSession: fakes.resolveCanonical }));
vi.mock('../../companion-cloud/homes.js', () => ({ isCompanionShadowed: fakes.isShadowed }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: fakes.getDb }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: fakes.createMessage }));
vi.mock('../../appBadgeService.js', () => ({ markSessionNeedsAttention: fakes.markAttention }));

// Unit: this port is the actual Desktop publication boundary. Runner coverage
// does not exercise chat routing, a committed receipt, or ownership changing
// during publication. The minimum fixture has one report run and two chats.
describe('teammate automation report publication', () => {
  const path = '/synthetic/owners/test-owner/bots/test-bot/workspace';
  const isEnabled = vi.fn(async () => true);
  const publish = createTeammateScheduledReportPublisher(isEnabled);
  type Request = Parameters<typeof publish>[0];
  const schedule = { id: 'schedule', name: 'Synthetic check', source: 'project', projectConfigId: 'check',
    workingDir: path } as Request['schedule'];
  const run = { id: 'test-run', scheduleId: 'schedule', status: 'success', sessionId: 'execution', firedAt: 1 } as const;
  const report = 'Synthetic final report';
  let receipt: { id: string } | undefined;
  let ownerCurrent = true;
  const assertCurrent = () => { if (!ownerCurrent) throw new Error('Owner changed'); };
  const request = () => ({
    schedule, run, report, assertCurrent,
    signal: new AbortController().signal, ownerScope: {} as Request['ownerScope'],
  });

  beforeEach(() => {
    vi.resetAllMocks();
    receipt = undefined;
    ownerCurrent = true;
    isEnabled.mockResolvedValue(true);
    fakes.resolveProject.mockResolvedValue({ botId: 'test-bot', state: 'active' });
    fakes.resolveCanonical.mockResolvedValue({ status: 'resolved', sessionId: 'main-chat' });
    fakes.isShadowed.mockReturnValue(false);
    fakes.getDb.mockReturnValue({
      drizzle: {
        select: () => ({
          from: (table: unknown) => {
            const limit = async () => table === sessions ? [{ source: 'bot', status: 'active' }]
              : table === botProfiles ? [{ status: 'active' }]
                : table === messages && receipt ? [receipt] : [];
            return { where: () => ({ limit }), innerJoin: () => ({ where: () => ({ limit }) }) };
          },
        }),
      },
    });
    fakes.createMessage.mockImplementation(async (_session, _body, options) => {
      await options.beforePublish();
      receipt = { id: 'saved-report' };
      return receipt;
    });
  });

  it('writes one native assistant report and reuses its durable receipt on retries', async () => {
    const input = request();
    expect(await Promise.all([publish(input), publish(input)])).toEqual([true, true]);
    fakes.resolveCanonical.mockResolvedValue({ status: 'resolved', sessionId: 'replacement-main-chat' });
    expect(await publish(input)).toBe(true);
    expect(fakes.createMessage).toHaveBeenCalledExactlyOnceWith('main-chat', {
      clientId: 'schedule-main-chat-report:test-run',
      role: 'assistant',
      content: report,
      agentMeta: {
        turnCompleted: true,
        origin: { kind: 'scheduler', scheduleId: 'schedule', scheduleName: 'Synthetic check', runId: 'test-run' },
      },
    }, expect.objectContaining({ broadcastOwnerScope: input.ownerScope }));
    expect(fakes.markAttention).toHaveBeenCalledExactlyOnceWith('main-chat');
  });

  it('keeps ordinary projects, missing opt-in, and empty reports free of chat writes', async () => {
    expect(await publish({ ...request(), schedule: { ...schedule, workingDir: '/ordinary-project' } })).toBe(false);
    expect(fakes.resolveProject).not.toHaveBeenCalled();
    isEnabled.mockResolvedValueOnce(false);
    expect(await publish(request())).toBe(false);
    expect(await publish({ ...request(), report: '  ' })).toBe(true);
    expect(fakes.createMessage).not.toHaveBeenCalled();
    expect(fakes.markAttention).not.toHaveBeenCalled();
  });

  it.each(['owner', 'canonical chat', 'companion home', 'opt-in'] as const)(
    'blocks a staged write when the %s changes',
    async (boundary) => {
      fakes.createMessage.mockImplementationOnce(async (_session, _body, options) => {
        if (boundary === 'owner') ownerCurrent = false;
        if (boundary === 'canonical chat') fakes.resolveCanonical.mockResolvedValue({ status: 'resolved', sessionId: 'other' });
        if (boundary === 'companion home') fakes.isShadowed.mockReturnValue(true);
        if (boundary === 'opt-in') isEnabled.mockResolvedValue(false);
        await options.beforePublish();
        receipt = { id: 'must-not-exist' };
      });
      await expect(publish(request())).rejects.toThrow();
      expect(receipt).toBeUndefined();
      expect(fakes.markAttention).not.toHaveBeenCalled();
    },
  );
});
