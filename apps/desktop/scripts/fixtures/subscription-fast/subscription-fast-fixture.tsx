import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { SubscriptionFastSetting } from '../../../src/renderer/features/provider-share/SubscriptionFastSetting';
import { ProviderGroupSection } from '../../../src/renderer/features/provider-group/ProviderGroupSection';
import type { ProviderView } from '@cindy/model-providers';
import type { ProviderGroupConfig } from '../../../src/shared/providerGroup';

mountPage({
  host: (ctx) => {
    let config: ProviderGroupConfig = {
      strategy: 'least',
      autoSwitch: true,
      allowFast: ctx.data.allowFast !== false,
      members: [
        {
          key: 'local',
          kind: 'local',
          agentDeviceId: null,
          providerId: 'openai',
          limit: 10,
          weight: 1,
          paused: false,
        },
      ],
    };
    const view = () => ({
      providerId: 'openai',
      config,
      fastPolicyPending: ctx.data.pending === true,
      members: [{ key: 'local', state: 'ready', running: 0, limit: 10, label: 'Mac Studio' }],
    });
    return {
      providerGroup: {
        command: async (command: any) => {
          if (command.action === 'get') return view();
          if (command.action === 'list') return { openai: config };
          if (command.action === 'save' || command.action === 'save-if-current') {
            config = command.config;
            return view();
          }
          return forbid(`providerGroup.${command.action}`)();
        },
        onChanged: subscription('providerGroupChanged'),
      },
      providerShare: {
        command: async (command: any) => {
          if (command.action === 'received') return [];
          if (command.action === 'received-snapshot') return { received: [], confirmedRegions: [] };
          if (command.action === 'set-fast-policy')
            return { supported: true, allowFast: command.allowFast };
          return forbid(`providerShare.${command.action}`)();
        },
        onReceivedChanged: subscription('received'),
        onOwnedChanged: subscription('owned'),
      },
      deviceLink: {
        listDevices: async () => ({ devices: [] }),
        getState: async () => ({ linkStatus: 'online' }),
        onPresenceChanged: subscription('presence'),
        onStatusChanged: subscription('status'),
      },
    };
  },
  render: (ctx) => (
    <div
      data-testid="subscription-fast-fixture"
      className="flex h-screen min-w-0 flex-col gap-5 overflow-auto bg-content-area p-4"
    >
      <SubscriptionFastSetting
        provider={
          {
            id: 'openai',
            subscriptionFastPolicy: {
              allowFast: ctx.data.allowFast !== false,
              groupAllowsFast: true,
            },
          } as ProviderView
        }
      />
      <ProviderGroupSection providerId="openai" providerName="OpenAI" fastPolicySupported />
    </div>
  ),
});
