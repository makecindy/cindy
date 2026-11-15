import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';

/** Click/touch and native keyboard disclosure; essential scope stays visible when closed. */
export function StrategyDetails({ label, scope, children }: { label: string; scope: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="min-w-0 space-y-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
      <p>{scope}</p>
      <Button variant="secondary" tone="quiet" size="sm" aria-expanded={open} aria-controls={id}
        data-settings-search-action="Expand allocation strategy explanations and limitations"
        onClick={() => setOpen(value => !value)}>
        {label}
      </Button>
      <Collapse open={open} id={id}>
        <div className="space-y-3">{children}</div>
      </Collapse>
    </div>
  );
}
