import type { ReactNode } from 'react';

/** The loaded cards and placeholders use the exact same grid and row height. */
export function PluginRecommendationSlots({ loading, children }: { loading: boolean; children: ReactNode }) {
  return <div className="grid auto-rows-[138px] grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3 [&>article]:h-full">
    {loading ? Array.from({ length: 3 }, (_, index) => <div key={index} aria-hidden="true"
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]" />) : children}
  </div>;
}
