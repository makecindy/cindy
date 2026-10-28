import { mountPage } from '../../ui-page/harness';
import { SshAuthenticationForm } from '../../../src/renderer/components/SshAuthenticationDialogHost';

void mountPage({
  render: ctx => <SshAuthenticationForm request={{
    requestId: 'fixture', expiresAt: Date.now() + 120_000,
    host: { id: 'fixture-host', hostname: '192.0.2.10', port: 2222,
      user: ctx.data.multiple ? 'test@00000000-0000-0000-0000-000000000001@00000000-0000-0000-0000-000000000002' : 'test' },
    name: 'MFA',
    instructions: ctx.data.multiple ? 'Enter your authentication information. '.repeat(8) : 'Enter your one-time verification code.',
    prompts: ctx.data.multiple
      ? [{ prompt: 'Verification code', echo: false }, { prompt: 'Confirmation', echo: true }]
      : [{ prompt: 'Verification code', echo: false }],
  }} onAnswer={async () => {}} />,
});
