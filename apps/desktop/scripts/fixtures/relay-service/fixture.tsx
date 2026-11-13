import { RelayServicePanel, useSelfHostedRelayState } from '../../../src/renderer/components/settings/RelayServicePanel';
import { RelayShareGlobalHost } from '../../../src/renderer/features/relay-share/RelayShareGlobalHost';
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

/** account:同账号另一台电脑正在用的服务器中转。 */
const accountRelay = {
  ownerDeviceId: 'macbook-pro', ownerDeviceName: 'Lizi MacBook Pro', relayId: '44444444-4444-4444-8444-444444444444',
  name: 'Home relay', baseUrl: 'https://198.51.100.40', kind: 'server' as const,
};

/** pending:手机用分享链接申请加入,等主人处理。 */
const pendingRequest = {
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceName: 'Pixel 9', platform: 'android',
  verifyCode: '5461', replacesExisting: false, verified: true,
};

/** tenant:另一个账号用分享链接申请使用这个中转。 */
const tenantRequest = {
  requestId: 'tenant:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceName: 'Bob MacBook Air', platform: null,
  verifyCode: '0712', replacesExisting: false, verified: true, accountName: 'Bob',
};
/** shared:别人分享给这个账号、这台电脑在上面建了本账号的网络。 */
const sharedRelay = {
  name: 'Lizi relay', baseUrl: 'https://198.51.100.50', role: 'owner' as const, origin: 'join' as const,
  relayId: '55555555-5555-4555-8555-555555555555', shared: { ownerName: 'Lizi' },
};

/**
 * default:官方在用、服务器中转已部署未使用;server:正在用服务器中转;host:这台电脑当中转在用;
 * multi:两台服务器,正在用第一台;retry-*:一次失败的部署;deploy-steady:从头部署一台;
 * share:正在用服务器中转,打开分享窗口;pending:收到一条加入申请,自动弹出审批;
 * account:官方在用,同账号另一台电脑的中转出现在列表里,切换后自动加入;
 * tenant:另一个账号申请使用,已分享给一个账号;shared:用着别人分享的中转;
 * share-own:中转还不能分享给其他账号时的分享窗口。
 */
function initialState(name: string): SelfHostedRelayState {
  const server = ['server', 'multi', 'share', 'pending', 'tenant', 'share-own'].includes(name);
  const shared = name === 'shared';
  const host = name === 'host';
  const recovering = name.startsWith('retry-');
  const redeploy = name === 'retry-existing';
  const fresh = name === 'deploy-steady';
  const finishedAt = Date.now();
  const first = { ...deployment, active: server, ...(recovering && !redeploy ? { relayVersion: '' } : {}) };
  return {
    available: true,
    mode: server || host || shared ? 'self-hosted' : 'official',
    relay: server
      ? serverRelay(deployment)
      : host
        ? { name: 'This computer', baseUrl: 'http://127.0.0.1:47820', role: 'owner', origin: 'host' }
        : shared
          ? sharedRelay
          : null,
    issue: null,
    host: {
      enabled: host, running: host, error: null, port: 47820, listenAll: host, externalUrl: null,
      suggestedUrls: ['http://192.168.1.20:47820'],
    },
    deployments: fresh || name === 'account' || shared ? [] : name === 'multi' ? [first, backup] : [first],
    accountRelays: name === 'account' ? [accountRelay] : [],
    ...(name === 'tenant'
      ? { tenants: [{ tenantId: '66666666-6666-4666-8666-666666666666', accountName: 'Alice', devices: 2, online: true, createdAt: '2026-11-09T08:00:00Z' }] }
      : {}),
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
    pendingRequests: name === 'pending'
      ? [{ ...pendingRequest, requestedAt: new Date(finishedAt - 60_000).toISOString() }]
      : name === 'tenant'
        ? [{ ...tenantRequest, requestedAt: new Date(finishedAt - 30_000).toISOString() }]
        : [],
    join: { status: 'idle' },
  };
}

function Page() {
  const controller = useSelfHostedRelayState(true);
  return (
    <div className="mx-auto max-w-3xl p-4">
      <RelayServicePanel controller={controller} />
      {/* 审批弹窗在主界面上全局挂载;这里一并挂上,「处理」才能打开它。 */}
      <RelayShareGlobalHost />
    </div>
  );
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
          if (command.type === 'state' || command.type === 'refresh-account-relays') return { state };
          if (ctx.case === 'account' && command.type === 'join-account-relay') {
            // 先写申请、等那台电脑回写链接,再经中转加入;这里直接走完。
            state = { ...state, join: { status: 'connecting', accountRelayId: command.relayId } };
            setTimeout(() => publish({
              ...state, mode: 'self-hosted',
              relay: { name: accountRelay.name, baseUrl: accountRelay.baseUrl, role: 'member', origin: 'join', relayId: accountRelay.relayId },
              join: { status: 'joined', relayName: accountRelay.name },
            }), 300);
            return { state };
          }
          if (command.type === 'deployment-status') {
            const certificateExpiresAt = new Date(Date.now() + 5.5 * 86_400_000).toISOString();
            return { state, deploymentStatus: { online: true, devices: 3, onlineDevices: 2, certificateExpiresAt, agentNet: true, tenants: false } };
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
          if (ctx.case === 'share' && command.type === 'create-join-link') {
            // 打开时沿用、「重新生成」另要一条,都换一个可辨认的加入码。
            const code = command.fresh ? 'second' : 'first';
            state = {
              ...state,
              joinLink: {
                link: `cindydev://relay/join?u=https%3A%2F%2F203.0.113.10&c=${code}-aOwKuLXRipilvt81DCuh&o=x1nybZCVrqZOn6iI1YNmHC1X1y&s=1J6z9KmBOHdZxDGCHtC1d`,
                expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              },
            };
            return { state };
          }
          if (ctx.case === 'share-own' && command.type === 'create-join-link') {
            state = {
              ...state,
              joinLink: {
                link: 'cindydev://relay/join?u=https%3A%2F%2F203.0.113.10&c=own-aOwKuLXRipilvt81DCuh&o=x1nybZCVrqZOn6iI1YNmHC1X1y&s=1J6z9KmBOHdZxDGCHtC1d',
                expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                otherAccounts: false,
              },
            };
            return { state };
          }
          if ((ctx.case === 'pending' || ctx.case === 'tenant') && command.type === 'decide') {
            if (ctx.case === 'tenant' && !command.requestId.startsWith('tenant:')) return forbid('expected the other account request')();
            publish({
              ...state,
              pendingRequests: state.pendingRequests.filter((item) => item.requestId !== command.requestId),
              ...(ctx.case === 'tenant' && command.approve
                ? { tenants: [...(state.tenants ?? []), { tenantId: '77777777-7777-4777-8777-777777777777', accountName: 'Bob', devices: 1, online: true, createdAt: new Date().toISOString() }] }
                : {}),
            });
            return { state };
          }
          if (ctx.case === 'tenant' && command.type === 'revoke-tenant') {
            publish({ ...state, tenants: (state.tenants ?? []).filter((tenant) => tenant.tenantId !== command.tenantId) });
            return { state };
          }
          if (ctx.case === 'shared' && command.type === 'use-official') {
            publish({ ...state, mode: 'official', relay: null });
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
