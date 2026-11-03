import { RemoteBotFollowUpInvitation } from '../../../src/renderer/features/bots/RemoteBotFollowUpInvitation';
import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotAutonomySettings } from '../../../src/renderer/features/bots/BotAutonomySettings';
import { BotFollowUpInvitation } from '../../../src/renderer/features/bots/BotFollowUpInvitation';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { Button } from '../../../src/renderer/components/ui/button';

let override: string | null | undefined;
function view() {
  return { schedulerBotId: override ?? null, isCustomized: override !== undefined, defaults: { schedulerBotId: null } };
}
function Chat({ initiallyEngaged }: { initiallyEngaged: boolean }) {
  const [engaged, setEngaged] = useState(initiallyEngaged);
  return <div className="mx-auto flex w-full max-w-lg flex-col gap-6 p-4">
    <p className="text-16 font-medium leading-6 text-[var(--text-primary)]">Cindy</p>
    <BotFollowUpInvitation botId="cindy-default" engaged={engaged} />
    {!engaged && <Button data-testid="send" onClick={() => setEngaged(true)}>Hello Cindy</Button>}
  </div>;
}
mountPage({
  host: (ctx) => {
    override = ctx.case === 'settings-on' ? 'cindy-default' : undefined;
    return {
      deviceLink: { invoke: async (_device: string, channel: string) => channel.endsWith(':get') ? {
        ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:cindy-default/follow-up' },
        revision: '1', display: { title: '跟进我的任务' }, links: [],
        blocks: [{ id: 'follow-up', primitive: 'form', fallbackMarkdown: '开启后，我会读取伙伴所在电脑上你创建的任务摘要，分析进展并提醒你重要变化。这会使用模型额度，你可以随时关闭。', data: {
          actionId: 'enable-grant', values: { enabled: false }, invitationAvailable: true, operationActions: { dismiss: 'dismiss-grant' },
        } }],
        actions: [{ id: 'enable-grant', label: 'Follow up', fields: [{ id: 'enabled', kind: 'toggle', label: 'Enabled' }] }, { id: 'dismiss-grant', label: 'Not now' }],
      } : { effects: [] } },
      localDb: { bots: { autonomy: {
        getSettings: async () => view(),
        setSettings: async ({ schedulerBotId }: { schedulerBotId: string | null }) => { override = schedulerBotId; return view(); },
        resetSettings: async () => { override = undefined; return view(); },
      } } },
      maker: { onBotAutonomyChanged: subscription('autonomy') },
    };
  },
  render: (ctx) => <ConfirmDialogProvider>
    {ctx.case === 'remote' ? <div className="p-4"><RemoteBotFollowUpInvitation deviceId="host" botId="cindy-default" /></div> : ctx.case.startsWith('settings')
      ? <div className="mx-auto w-full max-w-lg p-6"><BotAutonomySettings botId="cindy-default" botName="Cindy" allowSchedulerFollow={false} onAllowSchedulerFollowChange={() => {}} /></div>
      : <Chat initiallyEngaged={ctx.case !== 'before-chat'} />}
  </ConfirmDialogProvider>,
});
