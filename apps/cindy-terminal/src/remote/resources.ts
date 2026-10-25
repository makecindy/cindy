import { createHash } from 'node:crypto';
import { buildProviderShareLink, scrubProviderShareLabel, PROVIDER_SHARE_NEUTRAL_DEVICE_NAME, type RemoteResourceRegistry, type RemoteCollectionItem, type RemoteActionDescriptor } from '@cindy/device-link';
import { type ProviderGroupConfig, PROVIDER_GROUP_STRATEGIES } from '@cindy/remote-agent/shared/providerGroup';
import type { TerminalRemoteAgentService } from './agent.js';
import type { TerminalProviderGroups } from './groups.js';
import type { TerminalMembershipService } from './membership.js';
import type { TerminalRemoteAccountService } from './account.js';
import type { TerminalRemoteModelGrants } from './model-grants.js';

import { remoteText as text, remoteString } from './text.js';
const modelKey = (model: string) => createHash('sha256').update(model).digest('hex');

/** Non-secret management uses the existing resource protocol on GUI and TUI. */
export function registerRemoteManagementResources(registry: RemoteResourceRegistry, options: {
  agent: TerminalRemoteAgentService; groups: TerminalProviderGroups; membership: TerminalMembershipService;
  account: TerminalRemoteAccountService; deviceId: string; apiBaseUrl(): string; remoteEnabled(): boolean;
  modelGrants: TerminalRemoteModelGrants;
}) {
  const providers = async (): Promise<RemoteCollectionItem[]> => (await options.agent.views()).map(provider => ({
    ref: { collectionId: 'remote-providers', kind: 'provider', id: provider.id }, revision: String(provider.remoteInvocationEnabled), links: [],
    display: { title: provider.name, subtitle: text(provider.remoteInvocationEnabled ? 'Remote access enabled' : 'Remote access off') },
    actions: [{ id: provider.remoteInvocationEnabled ? 'disable' : 'enable', label: provider.remoteInvocationEnabled ? text('Disable remote access', '关闭远程调用') : text('Enable remote access', '开启远程调用') },
      ...(provider.remoteInvocationEnabled ? [{ id: 'create-share', label: text('Create invitation') }] : [])],
  }));
  registry.register({
    collection: { id: 'remote-providers', resourceKind: 'provider', title: text('Remote providers', '远程供应商'), placement: 'settings' },
    list: async () => ({ collectionId: 'remote-providers', revision: '1', items: await providers() }),
    get: async (context, request) => {
      const item = (await providers()).find(item => item.ref.id === request.ref.id); if (!item) throw new Error('PROVIDER_NOT_FOUND');
      const provider=(await options.agent.views()).find(value=>value.id===item.ref.id)!;
      const models=[...new Set(Object.values(provider.models).flatMap(values=>values?.filter(model=>!model.disabled).map(model=>model.id)??[]))];
      const rule=options.modelGrants.read(provider.id);
      return {...item,actions:[...item.actions??[],{id:'models-all',label:text('Allow all models','允许全部模型')},...models.map(model=>({id:`model:${modelKey(model)}`,label:text(options.modelGrants.allows(provider.id,model)?'Disable {name}':'Enable {name}',undefined,{name:model})}))],blocks:[{id:'models',primitive:'text',fallbackMarkdown:rule.models===null?remoteString('All offered models',request.client.locale):rule.models.join('\n')||remoteString('No models allowed',request.client.locale)}]};
    },
    invoke: async (context, request) => {
      const provider = (await options.agent.views()).find(provider => provider.id === request.resourceRef?.id);
      if (!provider) throw new Error('PROVIDER_NOT_FOUND');
      const guard = () => context.assertCurrent?.(); guard();
      if(request.actionId==='models-all'||request.actionId.startsWith('model:')){
        const models=[...new Set(Object.values(provider.models).flatMap(values=>values?.filter(model=>!model.disabled).map(model=>model.id)??[]))];
        if(request.actionId==='models-all')await options.modelGrants.set(provider.id,null,undefined,guard);
        else {const selected=models.find(model=>modelKey(model)===request.actionId.slice(6));if(!selected)throw new Error('MODEL_NOT_FOUND');const previous=options.modelGrants.read(provider.id).models??models;await options.modelGrants.set(provider.id,previous.includes(selected)?previous.filter(model=>model!==selected):[...previous,selected],undefined,guard);}
        await options.agent.host.revalidateProviderAccess();
      }
      else if (request.actionId === 'enable' || request.actionId === 'disable') await options.agent.setEnabled(provider.id, request.actionId === 'enable', guard);
      else if (request.actionId === 'create-share') {
        if (!options.remoteEnabled() || provider.remoteInvocationEnabled !== true || !provider.connected) throw new Error('REMOTE_PROVIDER_NOT_ENABLED');
        const card = await options.account.identityCard('share-link', createHash('sha256').update(`${options.deviceId}:${provider.id}`).digest('hex')); guard();
        const created = await options.account.providerShares.createLink({ providerId: provider.id, providerLabel: scrubProviderShareLabel(provider.name), deviceName: PROVIDER_SHARE_NEUTRAL_DEVICE_NAME, identityCard: card }); guard();
        await options.membership.refresh();
        return { result: { link: buildProviderShareLink(created.invitation, options.apiBaseUrl()), expiresAt: created.expiresAt }, effects: [{ kind: 'toast', message: { fallback: buildProviderShareLink(created.invitation, options.apiBaseUrl()) } }] };
      } else throw new Error('INVALID_ACTION');
      return { effects: [{ kind: 'refresh-collection', collectionId: 'remote-providers' }] };
    },
  });
  const groupItems = async (): Promise<RemoteCollectionItem[]> => { await options.groups.list(); return (await options.agent.views()).map(provider => ({
    ref: { collectionId: 'provider-groups', kind: 'provider-group', id: provider.id }, revision: JSON.stringify(options.groups.read(provider.id)), links: [],
    display: { title: provider.name, subtitle: text(options.groups.read(provider.id)?.strategy ?? 'No group') },
    actions: [{ id: 'strategy', label: text('Strategy', '分配策略'), fields: [{ id: 'strategy', label: text('Strategy', '分配策略'), kind: 'select', required: true, options: PROVIDER_GROUP_STRATEGIES.map(value => ({ value, label: text(value) })) }] }],
  })); };
  registry.register({
    collection: { id: 'provider-groups', resourceKind: 'provider-group', title: text('Provider groups', '供应商组'), placement: 'settings' },
    list: async () => ({ collectionId: 'provider-groups', revision: '1', items: await groupItems() }),
    get: async (context, request) => {
      const item = (await groupItems()).find(item => item.ref.id === request.ref.id); if (!item) throw new Error('PROVIDER_NOT_FOUND');
      const id = item.ref.id, config = options.groups.read(id);
      const candidates = await options.groups.candidates(id);
      const actions: RemoteActionDescriptor[] = [...item.actions ?? []];
      if (candidates.length) actions.push({ id: 'add', label: text('Add computer', '添加电脑'), fields: [{ id: 'member', kind: 'select', required: true, label: text('Computer', '电脑'), options: candidates.filter(candidate => !candidate.blocked).map(candidate => ({ value: candidate.key, label: { fallback: candidate.label } })) }] });
      for (const member of config?.members ?? []) {
        actions.push({ id: `remove:${member.key}`, label: text('Remove {name}',undefined,{name:member.label??member.key}) });
        actions.push({ id: `pause:${member.key}`, label: text(member.paused?'Resume {name}':'Pause {name}',undefined,{name:member.label??member.key}) });
      }
      return { ...item, actions, blocks: [{ id: 'members', primitive: 'text', fallbackMarkdown: (await options.groups.router.view(id)).members.map(member => `${member.label}: ${remoteString(member.state,request.client.locale)}`).join('\n') }] };
    },
    invoke: async (context, request) => {
      const id = request.resourceRef?.id; if (!id) throw new Error('INVALID_ACTION');
      const current = options.groups.read(id);
      const config: ProviderGroupConfig = current ? structuredClone(current) : { strategy: 'least', autoSwitch: true, members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: id, label: remoteString('This computer',request.client.locale), limit: 4, weight: 1, paused: false }] };
      if (request.actionId === 'strategy') {
        const strategy = request.input?.strategy;
        if (!PROVIDER_GROUP_STRATEGIES.includes(strategy as never)) throw new Error('INVALID_STRATEGY');
        config.strategy = strategy as ProviderGroupConfig['strategy'];
      } else if (request.actionId === 'add') {
        const candidate = (await options.groups.candidates(id)).find(candidate => candidate.key === request.input?.member && !candidate.blocked);
        if (!candidate) throw new Error('MEMBER_UNAVAILABLE');
        config.members.push({ key: candidate.key, kind: candidate.kind, agentDeviceId: candidate.agentDeviceId, providerId: candidate.providerId, label: candidate.label, limit: 4, weight: 1, paused: false });
      } else if (request.actionId.startsWith('remove:')) config.members = config.members.filter(member => member.key !== request.actionId.slice(7));
      else if (request.actionId.startsWith('pause:')) { const member = config.members.find(member => member.key === request.actionId.slice(6)); if (!member) throw new Error('MEMBER_NOT_FOUND'); member.paused = !member.paused; }
      else throw new Error('INVALID_ACTION');
      await options.groups.save(id, config, () => context.assertCurrent?.());
      return { effects: [{ kind: 'refresh-collection', collectionId: 'provider-groups' }, { kind: 'refresh-resource', ref: request.resourceRef! }] };
    },
  });
}
