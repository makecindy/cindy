import { useState } from 'react';
import { DraftProjectCompanionPicker } from '../../../src/renderer/features/cc-agent/DraftProjectCompanionPicker';
import { mountPage } from '../../ui-page/harness';

const partners = [
  { id: 'fixture-writer', name: '写作伙伴' },
  { id: 'fixture-reviewer', name: '代码伙伴' },
];

function Picker() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen items-start justify-center bg-[var(--surface-base)] p-8">
      <DraftProjectCompanionPicker partners={partners} value={value} onChange={setValue} />
    </div>
  );
}

void mountPage({ render: () => <Picker /> });
