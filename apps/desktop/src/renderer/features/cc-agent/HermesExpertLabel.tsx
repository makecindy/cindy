import { useEffect, useState } from 'react';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

type ExpertSessionBindingView = NonNullable<Awaited<ReturnType<Window['electronAPI']['maker']['experts']['getSessionBinding']>>>;

/**
 * Header chip naming the expert a Hermes session was started as (ROADMAP 3.2a). Hover shows the
 * expert folder so what drives the session is always findable on disk. A bound expert that no
 * longer loads is shown with a warning instead of disappearing.
 */
export function HermesExpertLabelView({ binding }: { binding: ExpertSessionBindingView | null }) {
  if (!binding) return null;
  const broken = Boolean(binding.error);
  const label = broken ? `${binding.slug} (broken)` : binding.name ?? binding.slug;
  const title = [
    `Expert: ${label}`,
    binding.model ? `Model route: ${binding.model}` : '',
    binding.error ?? '',
    binding.dir,
  ].filter(Boolean).join('\n');
  return (
    <span
      data-testid="hermes-session-expert"
      title={title}
      className={`mx-1 min-w-0 max-w-[14vw] shrink truncate rounded px-1.5 py-0.5 text-xs ${
        broken ? 'text-[var(--text-danger,#d33)]' : 'bg-[var(--bg-subtle,rgba(127,127,127,0.12))] text-[var(--text-secondary)]'
      }`}
      style={WINDOW_NO_DRAG_STYLE}
    >
      {label}
    </span>
  );
}

export function HermesExpertLabel({ agentKind, sessionId }: { agentKind: string; sessionId: string | null | undefined }) {
  const [binding, setBinding] = useState<ExpertSessionBindingView | null>(null);

  useEffect(() => {
    setBinding(null);
    const experts = window.electronAPI?.maker?.experts;
    if (agentKind !== 'hermes' || !sessionId || !experts) return undefined;
    let alive = true;
    const refresh = (): void => {
      void experts.getSessionBinding(sessionId)
        .then((next) => { if (alive) setBinding(next); })
        .catch(() => undefined);
    };
    refresh();
    const offSession = experts.onSessionEvent((event) => {
      if (event.type === 'bound' && event.sessionId === sessionId) refresh();
    });
    const offList = experts.onChanged(() => refresh());
    return () => {
      alive = false;
      offSession();
      offList();
    };
  }, [agentKind, sessionId]);

  return <HermesExpertLabelView binding={binding} />;
}
