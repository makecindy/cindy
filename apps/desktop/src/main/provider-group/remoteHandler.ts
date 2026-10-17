/**
 * 组所在电脑处理同账号其他电脑的 `provider-group:remote` 请求(docs/product-rules/provider-groups.md §4–§6)。
 *
 * 那台电脑上的任务选了本机的这个供应商：先来问该用组里哪台，再自己直接连过去运行；出问题时报告
 * 需要冷却的电脑，运行期间报告正在跑的任务，让本机的分配看到全组真实的负载；每轮结束后报告在组里别的电脑上
 * 用掉的用量，「远程与分享」页的用量才算得全(§7)。
 *
 * 只服务同账号电脑(dispatch 已拒绝受邀者与共享任务访客)，且只对仍「允许被远程调用」的供应商提供组：
 * 没开放的供应商对其他电脑本来就不可见。
 *
 * 另有一个只读查询发给任务所在的电脑(不论它有没有组)：手机与远程控制问这台电脑上的某个任务此刻归哪个组(§10)。
 */
import { PROVIDER_RUNNING_TURNS_FIELD } from '@cindy/device-link';

import {
  parseProviderGroupRemoteRequest,
  PROVIDER_GROUP_LOCAL_MEMBER_KEY,
  providerGroupDeviceCount,
  providerGroupSummaryForWire,
  type ProviderGroupConfig,
  type ProviderGroupRemotePick,
  type ProviderGroupRemoteSessionGroup,
  type ProviderGroupRemoteUsageRow,
  type ProviderGroupSessionGroup,
  type ProviderGroupUsagePartAck,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_FAILURE_COOLDOWN_MS } from './router.js';
import type { ProviderGroupOwnerScope } from './runtime.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 报告来的重置时刻最多信多远(账号用量上限最长按周重置)，避免一台电脑被异常时刻长期冷却。 */
export const PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS = 8 * 24 * 60 * 60_000;

export interface ProviderGroupRemoteHandlerDeps {
  /** 当前账号的分配器与负载(每个请求开头取一次，整个请求都用这一份)。 */
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  /** 这个供应商仍对其他电脑开放(「允许被远程调用」)。 */
  isRemoteAllowed(providerId: string): boolean;
  now(): number;
  /** 同账号电脑报告来的用量：整体替换那台从 sinceDay 起的行(记进当前账号的按使用方账本)。 */
  replaceReportedUsage(controller: string, sinceDay: string | null, rows: ProviderGroupRemoteUsageRow[]): void;
  /** 这台电脑上的任务此刻归哪个组(只读本机记录，读不到为 null)。 */
  sessionGroup(sessionId: string): Promise<ProviderGroupSessionGroup>;
}

/** 每个账号、每台报告来的电脑最近收下的用量报告序号(乱序到达的旧份丢弃)。按账号的负载对象区分账号。 */
const usageReportSeqs = new WeakMap<object, Map<string, number>>();

/** 每个账号、每台报告电脑只暂存一份；断开后保留旧账本，后续完整报告会重发。 */
interface PendingUsageReport {
  seq: number;
  sinceDay: string | null;
  total: number;
  rows: ProviderGroupRemoteUsageRow[];
  lastAt: number;
}
const pendingUsageReports = new WeakMap<object, Map<string, PendingUsageReport>>();
export const PROVIDER_GROUP_USAGE_PART_TTL_MS = 10 * 60_000;

/**
 * 给同账号电脑的 `maker:provider:list` 补组摘要与运行数：建了组的供应商都带 `group`，
 * 让关闭远程调用的组仍能从设置进入管理；`running`(这台电脑上每个供应商正在运行一轮的任务数，
 * localLoad.ts)只给仍允许被远程调用的供应商附加 `runningTurns`，没在跑的为 0，读不到(null)时不带。
 * 结果里已有的这两个字段一律先去掉，只有本机能产生它们。
 */
export function decorateProviderListWithGroups(
  result: unknown,
  readGroup: (providerId: string) => ProviderGroupConfig | null,
  running: ReadonlyMap<string, number> | null = null,
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const value = result as { providers?: unknown };
  if (!Array.isArray(value.providers)) return result;
  return {
    ...value,
    providers: value.providers.map((provider: unknown) => {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return provider;
      const entry = { ...(provider as Record<string, unknown>) };
      delete entry.group;
      delete entry[PROVIDER_RUNNING_TURNS_FIELD];
      if (typeof entry.id !== 'string') return entry;
      const config = readGroup(entry.id);
      if (config) entry.group = providerGroupSummaryForWire(config);
      if (entry.remoteInvocationEnabled !== true) return entry;
      if (running) entry[PROVIDER_RUNNING_TURNS_FIELD] = running.get(entry.id) ?? 0;
      return entry;
    }),
  };
}

/**
 * 分享出去的供应商建了组时提供台数(provider-groups.md §8)，不返回组员名单；匿名状态由受邀者分配器按需提供。
 * 台数按电脑算(2026-10-15)：同一台电脑上的几个账号算一台，与匿名状态的项数一致(sharedStatus.ts)。
 * 供应商不再允许被远程调用时分享本身就不可用，不报台数。
 */
export function sharedProviderGroupSize(
  deps: Pick<ProviderGroupRemoteHandlerDeps, 'readGroup' | 'isRemoteAllowed'>,
  providerId: string,
): number | null {
  if (!deps.isRemoteAllowed(providerId)) return null;
  const count = providerGroupDeviceCount(deps.readGroup(providerId)?.members ?? []);
  return count > 0 ? count : null;
}

export async function handleProviderGroupRemote(
  deps: ProviderGroupRemoteHandlerDeps,
  controller: string,
  raw: unknown,
): Promise<
  ProviderGroupRemotePick | ProviderGroupView | ProviderGroupUsagePartAck | ProviderGroupRemoteSessionGroup | Record<string, never>
> {
  const request = parseProviderGroupRemoteRequest(raw);
  if (request.action === 'session-group') return { group: await deps.sessionGroup(request.sessionId) };
  const scope = deps.scope();
  switch (request.action) {
    case 'pick': {
      const { providerId } = request;
      if (!deps.isRemoteAllowed(providerId) || !deps.readGroup(providerId)) return { kind: 'none' };
      const pick = await scope.router.pick({
        providerId,
        agentKind: request.agentKind,
        model: request.model,
        exclude: new Set(request.exclude),
        // 带着这一轮试过的来问：那台电脑试过不行，本机现读最新状态再选(状态以本机为准，2026-10-11)。
        ...(request.exclude.length > 0 ? { fresh: true } : {}),
        // 选中的同一步记上临时占用：同时来的几个请求不会读到同一份负载、全落到同一台。
        onPicked: (memberKey) => scope.externalLoad.recordPick(controller, request.sessionId, providerId, memberKey),
      });
      // 等目录期间换了账号：这是上一个账号的组(占用也记在上一个账号那份里，随它作废)，不作数。
      if (!scope.isCurrent() || pick.kind === 'none') return { kind: 'none' };
      if (pick.kind === 'unavailable') return { kind: 'unavailable' };
      const { key, kind, agentDeviceId, providerId: memberProviderId } = pick.member;
      return { kind: 'member', member: { key, kind, agentDeviceId, providerId: memberProviderId }, label: pick.label };
    }
    case 'cool':
    case 'cool-model': {
      const config = deps.readGroup(request.providerId);
      if (!config || !config.members.some((m) => m.key === request.memberKey)) return {};
      const now = deps.now();
      const until = request.cause === 'usage-limit'
        ? Math.min(
          request.resetAt !== undefined && request.resetAt > now ? request.resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
          now + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS,
        )
        : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
      // Old controllers cannot identify the affected model: never turn their report into a week-long account ban.
      const model = request.cause === 'usage-limit' ? request.model : undefined;
      scope.router.markCooling(request.providerId, request.memberKey,
        model ? until : Math.min(until, now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS), model);
      return {};
    }
    case 'leases':
      scope.externalLoad.replaceLeases(controller, request.seq, request.entries);
      return {};
    case 'view': {
      if (!deps.isRemoteAllowed(request.providerId)) return { providerId: request.providerId, config: null, members: [] };
      const options = request.model !== undefined
        ? request.includeGuestSupport === true
          ? { model: request.model, includeGuestSupport: true }
          : request.model
        : { includeGuestSupport: request.includeGuestSupport === true };
      const view = await scope.router.view(request.providerId, options);
      return scope.isCurrent() && deps.isRemoteAllowed(request.providerId)
        ? view : { providerId: request.providerId, config: null, members: [] };
    }
    case 'usage':
    case 'usage-part': {
      if (!scope.isCurrent()) return {};
      let seqs = usageReportSeqs.get(scope.externalLoad);
      if (!seqs) {
        seqs = new Map();
        usageReportSeqs.set(scope.externalLoad, seqs);
      }
      const ack = (committed: boolean): ProviderGroupUsagePartAck | Record<string, never> =>
        request.action === 'usage-part'
          ? { seq: request.seq, received: request.offset + request.rows.length, committed }
          : {};
      if ((seqs.get(controller) ?? -1) >= request.seq) return ack(true);
      let incoming = request.rows;
      let pending = pendingUsageReports.get(scope.externalLoad);
      if (request.action === 'usage-part') {
        if (!pending) {
          pending = new Map();
          pendingUsageReports.set(scope.externalLoad, pending);
        }
        const now = deps.now();
        for (const [device, report] of pending) {
          if (now - report.lastAt >= PROVIDER_GROUP_USAGE_PART_TTL_MS) pending.delete(device);
        }
        let report = pending.get(controller);
        if (!report || report.seq < request.seq) {
          if (request.offset !== 0) throwIpcError('PRECONDITION_FAILED', 'usage report must restart from first part');
          report = { seq: request.seq, sinceDay: request.sinceDay, total: request.total, rows: [], lastAt: now };
          pending.set(controller, report);
        }
        if (report.seq !== request.seq || report.total !== request.total || report.sinceDay !== request.sinceDay
          || request.offset !== report.rows.length) {
          throwIpcError('PRECONDITION_FAILED', 'usage report part does not match pending report');
        }
        // 未收齐时不动账本，下一批失败、进程重启或换账号都不会用半份覆盖完整记录。
        incoming = [...report.rows, ...request.rows];
        if (incoming.length < report.total) {
          report.rows = incoming;
          report.lastAt = now;
          return ack(false);
        }
      }
      // 分到本机这台的那部分本机自己记过，报来的不再算一次。不按现在有没有组筛：组删了又建、这次整份报告时
      // 那几个供应商的历史也要留着(报告整体替换那台从 sinceDay 起的全部行)。
      const rows = incoming.filter((row) => row.memberKey !== PROVIDER_GROUP_LOCAL_MEMBER_KEY);
      deps.replaceReportedUsage(controller, request.sinceDay, rows);
      // 只有替换成功才记去重序号；落盘入口抛错时同一份仍能重试。
      seqs.set(controller, request.seq);
      if ((pending?.get(controller)?.seq ?? Infinity) <= request.seq) pending?.delete(controller);
      return ack(true);
    }
  }
}
