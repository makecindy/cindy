export type LearnDesktopCommandFeedback =
  | { kind: 'toast'; level: 'warning' | 'error'; i18nKey: string }
  | { kind: 'insert-card'; runId: string };

export function resolveLearnDesktopCommandFeedback(payload: {
  error?: string;
  learnRunId?: string;
}): LearnDesktopCommandFeedback | null {
  switch (payload.error) {
    case 'learn-usage':
      return { kind: 'toast', level: 'warning', i18nKey: 'learn.toast.usage' };
    case 'learn-busy':
      return { kind: 'toast', level: 'warning', i18nKey: 'learn.toast.busy' };
    case 'learn-failed':
      return { kind: 'toast', level: 'error', i18nKey: 'learn.toast.failed' };
    case 'remote-unsupported':
      return { kind: 'toast', level: 'warning', i18nKey: 'commands.toast.remoteUnsupported' };
    default:
      return payload.learnRunId ? { kind: 'insert-card', runId: payload.learnRunId } : null;
  }
}
