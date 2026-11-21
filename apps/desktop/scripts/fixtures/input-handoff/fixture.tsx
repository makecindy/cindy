import { useTranslation } from 'react-i18next';
import type { InputHandoffSnapshot } from '@cindy/device-link';
import { mountPage } from '../../ui-page/harness';
import { Button } from '../../../src/renderer/components/ui/button';
import { InputHandoffDialog } from '../../../src/renderer/features/input-handoff/InputHandoffDialog';
import { InputHandoffStepForm } from '../../../src/renderer/features/input-handoff/InputHandoffStepForm';

function Form({ count, description = false }: { count: number; description?: boolean }) {
  const { t } = useTranslation();
  const snapshot: InputHandoffSnapshot = {
    kind: 'input_handoff', requestId: 'fixture', revision: 1, phase: 'ready',
    purpose: 'Account verification', stepNumber: 1,
    ...(description ? { purpose: '请填写用于完成验证的账号信息。'.repeat(20).slice(0, 200), note: '这些内容只用于当前页面的验证，请核对页面来源后填写。'.repeat(25).slice(0, 500), command: 'test-command --synthetic-input-only', agentControlled: true } : {}),
    source: { app: 'Browser', origin: 'https://example.test' },
    controls: Array.from({ length: count }, (_, i) => ({
      id: `field-${i}`, kind: 'text', label: i === 0 ? 'Account' : i === 1 ? 'Password' : `Field ${i + 1}`,
      contentType: i === 0 ? 'username' : i === 1 ? 'password' : 'text',
    })),
  };
  return <InputHandoffDialog open snapshot={snapshot} inputBlocked={false} error={null} onClose={() => {}}
    footer={<Button type="submit" form="handoff-fixture" data-input-handoff-continue="" className="w-full">{t('inputHandoff.action.continue')}</Button>}>
    <InputHandoffStepForm formId="handoff-fixture" snapshot={snapshot} busy={false} inputBlocked={false} onSubmit={async () => true} />
  </InputHandoffDialog>;
}

void mountPage({ render: (ctx) => <Form count={Number(ctx.data.count)} description={Boolean(ctx.data.description)} /> });
