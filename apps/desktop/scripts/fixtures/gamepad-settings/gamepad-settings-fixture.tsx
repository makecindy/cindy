import { mountPage } from '../../ui-page/harness';
import { WorkLouderCodexSettings } from '../../../src/renderer/components/settings/WorkLouderCodexSettings';
import { XboxGamepadSettings } from '../../../src/renderer/components/settings/XboxGamepadSettings';

const noop = () => {};

mountPage({
  render: (ctx) => (
    <div data-gamepad-settings className="mx-auto max-w-[720px] p-5">
      {ctx.case === 'worklouder' ? <WorkLouderCodexSettings onBack={noop} /> : <XboxGamepadSettings family="xbox" onBack={noop} />}
    </div>
  ),
});
