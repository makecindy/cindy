import { useEffect, useState } from 'react';

import type { ExpertEntry } from '@cindy/maker-core/experts';

/**
 * New-task "Expert" picker for Hermes drafts (ROADMAP 3.2a). The pick is held by main as the
 * pending expert and bound to the next fresh Hermes session on its first send; the session
 * header then shows it. Experts are read from ~/.cindy-harness/experts; broken or non-Hermes
 * experts are listed but cannot be picked.
 */

export interface ExpertOption {
  slug: string;
  label: string;
  disabled: boolean;
  title: string;
}

export function buildExpertOptions(entries: readonly ExpertEntry[]): ExpertOption[] {
  return entries.map((entry) => {
    const expert = entry.expert;
    if (!expert) {
      return { slug: entry.slug, label: `${entry.slug} (broken)`, disabled: true, title: entry.error ?? 'cannot load' };
    }
    if (expert.agent !== 'hermes') {
      return {
        slug: entry.slug,
        label: `${expert.name} (${expert.agent}, not supported yet)`,
        disabled: true,
        title: 'Only Hermes experts can be started yet.',
      };
    }
    const parts = [expert.description, expert.model ? `Model route: ${expert.model}` : '', entry.dir].filter(Boolean);
    return { slug: entry.slug, label: expert.name, disabled: false, title: parts.join('\n') };
  });
}

export function HermesExpertPickerView({
  options,
  value,
  onChange,
}: {
  options: readonly ExpertOption[];
  value: string | null;
  onChange: (slug: string | null) => void;
}) {
  if (options.length === 0) return null;
  const selected = options.find((o) => o.slug === value);
  return (
    <select
      data-testid="hermes-expert-picker"
      aria-label="Expert"
      title={selected?.title ?? 'Start this task as an expert (~/.cindy-harness/experts)'}
      className="h-7 max-w-[11rem] shrink-0 truncate rounded-md border border-[var(--border-default)] bg-transparent px-1.5 text-xs text-[var(--text-secondary)]"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">No expert</option>
      {options.map((o) => (
        <option key={o.slug} value={o.slug} disabled={o.disabled} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function HermesExpertPicker() {
  const [entries, setEntries] = useState<ExpertEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const experts = window.electronAPI?.maker?.experts;
    if (!experts) return undefined;
    let alive = true;
    void experts.list().then((list) => { if (alive) setEntries(list); }).catch(() => undefined);
    void experts.getPending().then((slug) => { if (alive) setPending(slug); }).catch(() => undefined);
    const offList = experts.onChanged((list) => setEntries(list));
    const offSession = experts.onSessionEvent((event) => {
      if (event.type === 'pending') setPending(event.slug);
    });
    return () => {
      alive = false;
      offList();
      offSession();
    };
  }, []);

  return (
    <HermesExpertPickerView
      options={buildExpertOptions(entries)}
      value={pending}
      onChange={(slug) => {
        setPending(slug);
        void window.electronAPI?.maker?.experts.setPending(slug).catch(() => setPending(null));
      }}
    />
  );
}
