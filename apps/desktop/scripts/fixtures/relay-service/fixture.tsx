import { RelayServicePanel, useSelfHostedRelayState } from '../../../src/renderer/components/settings/RelayServicePanel';
import type {
  RelayDeployProgressMessage,
  RelayDeployStep,
  SelfHostedRelayCommand,
  SelfHostedRelayDeploymentView,
  SelfHostedRelayState,
} from '../../../src/shared/selfHostedRelay';
import { forbid, mountPage } from '../../ui-page/harness';

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
 * multi:两台服务器,正在用第一台;retry-*:一次失败的部署;deploy-steady:从头部署一台;
 * join-link(-narrow):这台电脑当中转,已生成加入链接(假的一次性参数);narrow 为窄设置栏。
 */
function initialState(name: string): SelfHostedRelayState {
  const server = name === 'server' || name === 'multi';
  const joinLink = name.startsWith('join-link');
  const host = name === 'host' || joinLink;
  const recovering = name.startsWith('retry-');
  const redeploy = name === 'retry-existing';
  const fresh = name === 'deploy-steady';
  const finishedAt = Date.now();
  const first = { ...deployment, active: server, ...(recovering && !redeploy ? { relayVersion: '' } : {}) };
  return {
    available: true,
    mode: server || host ? 'self-hosted' : 'official',
    relay: server
      ? serverRelay(deployment)
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
    joinLink: joinLink
      ? { link: 'cindy://relay/join?u=https%3A%2F%2Frelay.example.test&c=demo-code&o=demo-owner&s=demo-secret', expiresAt: new Date(finishedAt + 600_000).toISOString() }
      : null,
    pendingRequests: [],
    join: { status: 'idle' },
  };
}

function Page() {
  const controller = useSelfHostedRelayState(true);
  return <div className="mx-auto max-w-3xl p-4"><RelayServicePanel controller={controller} /></div>;
}

void mountPage({
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
      __relayDeployAdvance: (step: RelayDeployStep, message?: RelayDeployProgressMessage) => {
        const job = state.deployJob!;
        const logs = [...(job.logs ?? []), { at: (job.startedAt ?? 0) + (job.logs?.length ?? 0) * 1_000, step, ...(message ? { message } : {}) }];
        publish({ ...state, deployJob: { ...job, step, logs } });
      },
      __relayDeployFinish: finishDeploy,
    });
    return {
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
          hosts: [
            { config: { id: 'demo-server', displayName: 'demo-server', hostname: '203.0.113.10', user: 'root' } },
            { config: { id: 'backup-server', displayName: 'backup-server', hostname: '198.51.100.20', user: 'root' } },
          ],
        }),
      },
    };
  },
  render: () => <Page />,
});
