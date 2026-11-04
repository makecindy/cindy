import { RelayServicePanel, useSelfHostedRelayState } from '../../../src/renderer/components/settings/RelayServicePanel';
import type {
  RelayDeployProgressMessage,
  RelayDeployStep,
  SelfHostedRelayCommand,
  SelfHostedRelayDeploymentView,
  SelfHostedRelayState,
} from '../../../src/shared/selfHostedRelay';
import { forbid, mountPage } from '../../ui-page/harness';
import { useLocation } from 'react-router-dom';
import { getDraft } from '../../../src/renderer/lib/composerDraftStore';

const deployment: SelfHostedRelayDeploymentView = {
  relayId: '11111111-1111-4111-8111-111111111111',
  sshHostId: 'demo-server', address: '203.0.113.10', baseUrl: 'https://203.0.113.10', name: 'Test',
  relayVersion: '0.3.1', deployedAt: '2026-10-29T00:00:00Z', active: false, upgradeAvailable: false,
};
/** multi:第二台服务器上的中转。 */
const backup: SelfHostedRelayDeploymentView = {
  relayId: '22222222-2222-4222-8222-222222222222',
  sshHostId: 'backup-server', address: '198.51.100.20', baseUrl: 'https://198.51.100.20', name: 'Backup',
  relayVersion: '0.3.1', deployedAt: '2026-10-30T00:00:00Z', active: false, upgradeAvailable: false,
};

const serverRelay = (record: SelfHostedRelayDeploymentView) => ({ name: record.name, baseUrl: record.baseUrl, role: 'owner' as const, origin: 'server' as const });

/**
 * default:官方在用、服务器中转已部署未使用;server:正在用服务器中转;host:这台电脑当中转在用;
 * multi:两台服务器,正在用第一台;retry-*:一次失败的部署;deploy-steady:从头部署一台。
 */
function initialState(name: string): SelfHostedRelayState {
  const agentManaged = ['agent-upgrade', 'agent-remove', 'agent-resume'].includes(name);
  const publicAgentPreview = name.startsWith('agent-');
  const server = name === 'server' || name === 'multi' || (agentManaged && name !== 'agent-resume');
  const host = name === 'host';
  const recovering = name.startsWith('retry-');
  const redeploy = name === 'retry-existing';
  const fresh = name === 'deploy-steady';
  const finishedAt = Date.now();
  const first = {
    ...deployment, active: server, ...(recovering && !redeploy ? { relayVersion: '' } : {}),
    // Public evidence shows status and actions, never a server address or SSH identity.
    // These display placeholders are fixture data; production records are untouched.
    ...(publicAgentPreview ? {
      managedBy: 'agent' as const, deploymentKey: 'my-relay', sshHostId: '', address: '',
      baseUrl: '（连接地址已隐藏）', upgradeAvailable: false,
    } : {}),
    ...(name === 'agent-resume' ? { relayVersion: '', baseUrl: '', address: '' } : {}),
  };
  return {
    available: true,
    mode: server || host ? 'self-hosted' : 'official',
    relay: server
      ? serverRelay(first)
      : host
        ? { name: 'This computer', baseUrl: 'http://127.0.0.1:47820', role: 'owner', origin: 'host' }
        : null,
    issue: null,
    host: {
      enabled: host, running: host, error: null, port: 47820, listenAll: host, externalUrl: null,
      suggestedUrls: ['http://192.168.1.20:47820'],
    },
    deployments: fresh ? [] : name === 'multi' ? [first, backup] : [first],
    deployJob: recovering ? {
      action: 'deploy', status: 'failed', step: redeploy ? 'check' : 'runtime', error: redeploy ? 'DEPLOY_FAILED' : 'DOWNLOAD_FAILED',
      startedAt: finishedAt - 15_000, finishedAt, serverChanged: !redeploy, relayId: deployment.relayId,
      target: { sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, baseUrl: deployment.baseUrl },
      logs: redeploy
        ? [{ at: finishedAt - 15_000, step: 'check' }]
        : [{ at: finishedAt - 15_000, step: 'check' }, { at: finishedAt - 14_000, step: 'runtime' }],
    } : null,
    bundledRelayVersion: '0.3.1',
    joinLink: null,
    pendingRequests: [],
    join: { status: 'idle' },
  };
}

function Page() {
  const controller = useSelfHostedRelayState(true);
  const location = useLocation();
  if (location.pathname.startsWith('/cc-agent/')) {
    const id = location.pathname.split('/').at(-1)!;
    // The real draft stays available to behavioral assertions without entering public images.
    return <div data-testid="relay-agent-task" data-session-id={id} className="p-4 text-[var(--text-primary)]">
      <p className="text-13">任务草稿已准备好，可在任务中检查后发送。</p>
      <p className="mt-2 text-12 text-[var(--text-secondary)]">场景占位：不展示任务正文或部署参数。</p>
    </div>;
  }
  return <div className="mx-auto max-w-3xl p-4"><RelayServicePanel controller={controller} /></div>;
}

void mountPage({
  route: '/settings?tab=remote-control',
  host: ctx => {
    let state = initialState(ctx.case);
    const recovering = ctx.case.startsWith('retry-');
    const listeners = new Set<(next: SelfHostedRelayState) => void>();
    const publish = (next: SelfHostedRelayState) => {
      state = next;
      for (const listener of listeners) listener(state);
    };
    // 部署完成只保存记录,不切换线路(与 main 一致)。
    const finishDeploy = () => {
      const job = state.deployJob!;
      const record = { ...deployment, ...job.target!, relayId: job.relayId!, relayVersion: '0.3.1', active: false };
      publish({
        ...state,
        deployments: [...state.deployments.filter((item) => item.relayId !== record.relayId), record],
        deployJob: { ...job, step: 'finish', status: 'done', finishedAt: Date.now() },
      });
    };
    // deploy-steady:场景逐步推进部署任务,轮询与推送读到的是同一份状态。
    Object.assign(window, {
      __relayAgentDraft: (id: string) => getDraft(id)?.text?.content?.flatMap(
        (paragraph) => paragraph.content?.map((item) => item.text ?? '') ?? [],
      ).join('\n') ?? '',
      __relayDeployAdvance: (step: RelayDeployStep, message?: RelayDeployProgressMessage) => {
        const job = state.deployJob!;
        const logs = [...(job.logs ?? []), { at: (job.startedAt ?? 0) + (job.logs?.length ?? 0) * 1_000, step, ...(message ? { message } : {}) }];
        publish({ ...state, deployJob: { ...job, step, logs } });
      },
      __relayDeployFinish: finishDeploy,
    });
    return {
      localDb: {
        sessions: {
          create: async (body: Record<string, unknown>) => {
            if (body.workspaceKind !== 'dialogue' || body.remoteHostId || body.agentDeviceId || body.extraDirs || body.workingDir) {
              return forbid('relay task inherited a remote or project workspace')();
            }
            return { id: 'agent-relay-task', ...body };
          },
        },
      },
      selfHostedRelay: {
        command: async (command: SelfHostedRelayCommand) => {
          if (command.type === 'state') return { state };
          if (command.type === 'deployment-status') {
            const certificateExpiresAt = new Date(Date.now() + 5.5 * 86_400_000).toISOString();
            return { state, deploymentStatus: { online: true, devices: 3, onlineDevices: 2, certificateExpiresAt } };
          }
          if (recovering && command.type === 'check-server') {
            return ctx.case === 'retry-check-error'
              ? { state, check: { sshHostId: command.sshHostId, ok: false, error: 'PORT_BUSY_CONTAINER', detail: 'demo-nginx' } }
              : { state, check: { sshHostId: command.sshHostId, ok: true, system: 'Linux x86_64', plan: 'direct', existing: ctx.case === 'retry-replace' ? 'other' : 'mine' } };
          }
          if (recovering && command.type === 'deploy') {
            if (command.replaceExisting !== (ctx.case === 'retry-replace')) return forbid('unexpected relay replacement')();
            finishDeploy();
            return { state };
          }
          if (ctx.case === 'deploy-steady' && command.type === 'check-server') {
            // 检查要花一点时间:场景据此确认「检查中」和「可以部署」占同样的高度。
            await new Promise((resolve) => setTimeout(resolve, 400));
            return { state, check: { sshHostId: command.sshHostId, ok: true, system: 'Debian GNU/Linux 13 (trixie) · x86_64', plan: 'nginx', existing: 'none' } };
          }
          if (ctx.case === 'deploy-steady' && command.type === 'deploy') {
            const startedAt = Date.now();
            state = {
              ...state,
              deployJob: {
                action: 'deploy', status: 'running', step: 'check', startedAt, serverChanged: false,
                relayId: '33333333-3333-4333-8333-333333333333',
                target: { sshHostId: command.sshHostId, address: command.address, name: command.name, baseUrl: deployment.baseUrl },
                logs: [{ at: startedAt, step: 'check' }],
              },
            };
            return { state };
          }
          if (command.type === 'dismiss-deploy-job') {
            state = { ...state, deployJob: state.deployJob?.status === 'running' ? state.deployJob : null };
            return { state };
          }
          if (command.type === 'use-deployment') {
            const record = state.deployments.find((item) => item.relayId === command.relayId)!;
            state = {
              ...state, mode: 'self-hosted', relay: serverRelay(record),
              deployments: state.deployments.map((item) => ({ ...item, active: item.relayId === command.relayId })),
            };
            return { state };
          }
          if (ctx.case === 'multi' && command.type === 'rename-deployment') {
            state = {
              ...state,
              deployments: state.deployments.map((item) => (item.relayId === command.relayId ? { ...item, name: command.name } : item)),
            };
            return { state };
          }
          return forbid(`selfHostedRelay.command:${command.type}`)();
        },
        onChanged: (listener: (next: SelfHostedRelayState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      remoteSsh: {
        list: async () => ({
          hosts: ctx.case === 'agent-no-hosts' ? [] : [
            { config: { id: 'demo-server', displayName: 'demo-server', hostname: '203.0.113.10', user: 'root' } },
            { config: { id: 'backup-server', displayName: 'backup-server', hostname: '198.51.100.20', user: 'root' } },
          ],
        }),
      },
    };
  },
  render: () => <Page />,
});
