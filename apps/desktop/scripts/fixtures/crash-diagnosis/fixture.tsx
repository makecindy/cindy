import { mountPage, forbid } from '../../ui-page/harness';
import { StartupRecoveryDialogs } from '../../../src/renderer/components/log-support/StartupRecoveryDialogs';
mountPage({
  route: "/cc-agent/new",
  host: (ctx) => ({
    localDb: { sessions: {
      interruptedResumeCandidates: async () => ctx.data.recovery
        ? [{ sessionId: 'example', interruptedAt: Date.now(), activity: null }] : [],
      getMany: async () => [{ id: 'example', title: 'Example unfinished task', source: 'desktop',
        agentKind: 'cc', workingDir: '/example', createdAt: new Date().toISOString() }],
    } },
    getCrashDiagnosis: async () => ({ count: 1, details: 'Example unexpected exit' }),
    prepareCrashDiagnosis: forbid('prepareCrashDiagnosis'),
    dismissCrashDiagnosis: forbid('dismissCrashDiagnosis'),
  }),
  render: () => <StartupRecoveryDialogs />,
});
