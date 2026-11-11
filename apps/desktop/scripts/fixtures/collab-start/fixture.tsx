import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import { forbid, mountPage, subscription } from '../../ui-page/harness';
import {
  CreateWorkerPopover,
  type CreateWorkerForm,
} from '../../../src/renderer/features/cc-agent/CreateWorkerPopover';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
} from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type {
  WorkerProjectContext,
  WorkerProjectInfo,
} from '../../../src/shared/orca-worker-project';

const provider: ProviderView = {
  id: 'fixture-codex',
  name: 'Fixture',
  source: 'user',
  connected: true,
  remoteInvocationEnabled: true,
  agents: ['codex'],
  auth: { method: 'none' },
  routing: { codex: {} },
  models: {
    codex: [
      {
        id: 'fixture-model',
        name: 'Fixture Model',
        contextWindow: 200000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ],
  },
} as ProviderView;

const lead: WorkerProjectInfo = {
  directory: '/projects/cindy',
  baseRepo: '/projects/cindy',
  branch: 'main',
  headState: 'branch',
  exists: true,
  dirty: false,
  isWorktree: false,
};
const projects = ['cindy', 'design-system'].map((name) => ({
  path: `/projects/${name}`,
  name,
  description: `/projects/${name}`,
  missing: false,
}));

let submitted: CreateWorkerForm | null = null;
// 远程任务场景：任务在另一台电脑上，角色清单与记忆由那台电脑给出，改动也发给它。
const remoteRoleCalls: Array<{ channel: string; args: unknown[] }> = [];
const remoteRoles = {
  roles: [
    { role: 'researcher', task: 'Read the changelog', permission: 'auto' },
    { role: 'reviewer' },
    { role: 'developer' },
  ],
};
Object.assign(window, {
  collabStart: { submitted: () => submitted, remoteRoleCalls: () => remoteRoleCalls },
});

function Fixture({ scenario }: { scenario: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const addWorker = scenario === 'add-worker';
  return (
    <>
    {/* 只为验证「再次打开回到上次的角色」存在,截图时隐藏。 */}
    <button type="button" data-ui-page-control onClick={() => setOpen(true)}>
      Reopen
    </button>
    <CreateWorkerPopover
      // 新建任务的草稿还没有任务 id:不提供项目选择,也不预填检查类的首条任务。
      leadSessionId={scenario === 'draft' ? undefined : 'fixture-lead'}
      {...(scenario === 'remote' ? { deviceId: 'studio' } : {})}
      open={open}
      onClose={() => setOpen(false)}
      onCreate={(form) => {
        submitted = form;
        setOpen(false);
      }}
      {...(addWorker
        ? {}
        : {
            title: t('orca.createWorker.enableCollabTitle'),
            description: t('orca.createWorker.enableCollabDescription'),
            submitLabel: t('orca.createWorker.enableCollabSubmit'),
            requireWorkerPermissionModeSupport: true,
          })}
      executionDevicesEnabled={scenario !== 'remote'}
    />
    </>
  );
}

const capabilities = {
  availableModels: (provider.models.codex ?? []).map((model) => ({
    ...model,
    displayName: model.name,
  })),
  effortLevels: [],
  hasFastMode: false,
  supportsOrcaWorkerPermissionMode: true,
  permissionModes: [
    { id: 'auto', displayName: 'Auto' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ],
};

void mountPage({
  route: '/',
  host: (ctx) => {
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), {
      dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation,
      providers: [provider],
      providerOrder: [],
    });
    const selected: WorkerProjectInfo =
      ctx.case === 'missing-project'
        ? { ...lead, directory: '/projects/gone', baseRepo: null, branch: null, exists: false }
        : lead;
    return {
      maker: {
        getCapabilities: async () => capabilities,
        listAvailableAgents: async () => ['codex'],
        getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
        onProvidersChanged: subscription('providers'),
        send: forbid('maker.send'),
        enableOrca: forbid('maker.enableOrca'),
      },
      deviceLink: {
        onRemotePush: subscription('remotePush'),
        onPeerLinkReset: subscription('peerReset'),
        onStatusChanged: subscription('status'),
        onPresenceChanged: subscription('presence'),
        // 只有远程任务场景会经这里读那台电脑的数据。
        invoke: async (_device: string, channel: string, args: unknown[] = []) => {
          if (channel === 'maker:worker-roles:get') return remoteRoles;
          if (channel === 'maker:worker-roles:apply') {
            remoteRoleCalls.push({ channel, args });
            return { ok: true };
          }
          if (channel === 'maker:provider:list') return { providers: [provider] };
          if (channel === 'maker:get-capabilities') return capabilities;
          if (channel === 'maker:list-available-agents') return ['codex'];
          if (channel === 'maker:model-catalog:read') return { locations: [] };
          throw new Error(`Unexpected remote read: ${channel}`);
        },
      },
      localDb: {
        orcaWorkflows: {
          listExecutionDevices: async () => ({
            devices:
              ctx.case === 'draft'
                ? []
                : [{ deviceId: 'studio', name: 'Mac Studio', platform: 'darwin', supported: true }],
          }),
          projectContext: async (
            _id: string,
            directory?: string,
          ): Promise<WorkerProjectContext | WorkerProjectInfo> =>
            directory
              ? { ...lead, directory, baseRepo: directory }
              : {
                  recordedDirectory: lead.directory,
                  inherited: selected,
                  selected,
                  dialogue: false,
                  projects,
                },
        },
      },
      getNewMakerWorktreeBranchPreference: async () => null,
      worktreeListBranches: async () => ({ branches: ['main'] }),
    };
  },
  render: (ctx) => <Fixture scenario={ctx.case} />,
});
