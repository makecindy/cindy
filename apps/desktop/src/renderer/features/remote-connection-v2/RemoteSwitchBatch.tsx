/**
 * RemoteSwitchBatch —— 拓扑上方统计行里的「全部切到 Agent-Net」/「全部切回 Device Link」(原型)。
 * ---------------------------------------------------------------------------
 * 规则见 docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」(2026-11-12 用户确认:批量可以加，但要确保能切回来):
 * - 只列出现在能发起切换的电脑；两个方向都逐台问一次，旧版、打不开或本机选择仅加密的写原因、不切。
 * - 先切第一台，确认它经新方式连回来了再同时切其余的；第一台没切成就停下，其余保持原样。
 * - 每台的退回由对方自己判断(60 秒内没收到确认就退回)，这台电脑中途关掉也不会让对方卡在半路。
 * - 已经切过去的可以「全部切回 Device Link」；仅使用 Agent-Net 的电脑须先在那台电脑解除限制。
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  canAskToSwitch,
  probePeer,
  remoteSwitchStore,
  startRemoteSwitch,
  switchProbeKind,
  type RemoteSwitchEntry,
  type RemoteSwitchTarget,
} from './agentNetRemoteSwitch';
import type { TopologyNode } from './topologyModel';

type ItemState = 'waiting' | 'running' | 'done' | 'reverted' | 'failed' | 'skipped';
interface Run {
  target: RemoteSwitchTarget;
  ids: string[];
  states: Record<string, ItemState>;
  phase: 'running' | 'finished' | 'stopped';
}

const selectProbes = () => remoteSwitchStore.getSnapshot().probes;

function candidates(nodes: readonly TopologyNode[], entries: ReadonlyMap<string, RemoteSwitchEntry>, target: RemoteSwitchTarget): TopologyNode[] {
  return nodes
    .filter((n) => canAskToSwitch(n, entries.get(n.id) ?? null) && (target === 'agent-net' ? n.encrypted === false : n.encrypted === true))
    // 先切最可能成功的：上次没切成的排到后面，避免它当第一台把整批挡住。
    .sort((a, b) => Number(entries.get(a.id)?.kind === 'reverted') - Number(entries.get(b.id)?.kind === 'reverted') || a.name.localeCompare(b.name));
}

function BatchPanel({
  target,
  nodes,
  entries,
  onClose,
}: {
  target: RemoteSwitchTarget;
  nodes: readonly TopologyNode[];
  entries: ReadonlyMap<string, RemoteSwitchEntry>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const probes = useSyncExternalStore(remoteSwitchStore.subscribe, selectProbes);
  const [run, setRun] = useState<Run | null>(null);
  const [probed, setProbed] = useState(false);
  // 打开时冻结名单：切换途中设备的连接方式会变，名单不能跟着跳。
  const [list] = useState(() => candidates(nodes, entries, target));

  // 两个方向都先问：切回也不能绕过目标电脑的「仅使用 Agent-Net」选择。
  useEffect(() => {
    let active = true;
    void Promise.all(list.map((n) => probePeer(n.id))).then(() => { if (active) setProbed(true); });
    return () => { active = false; };
  }, [list]);

  const answer = (id: string) => switchProbeKind(probes.get(id), target);
  const ready = list.filter((n) => answer(n.id) === 'ready');
  const checking = !probed || list.some((n) => answer(n.id) === 'checking');

  const start = async () => {
    const ids = ready.map((n) => n.id);
    const states: Record<string, ItemState> = Object.fromEntries(ids.map((id) => [id, 'waiting' as ItemState]));
    const update = (id: string, state: ItemState) => setRun((cur) => (cur ? { ...cur, states: { ...cur.states, [id]: state } } : cur));
    setRun({ target, ids, states, phase: 'running' });
    const [first, ...rest] = ids;
    update(first, 'running');
    const stateOf = (result: Awaited<ReturnType<typeof startRemoteSwitch>>): ItemState =>
      result === 'done' ? 'done' : result === 'reverted' ? 'reverted' : 'failed';
    const firstResult = await startRemoteSwitch(first, target);
    update(first, stateOf(firstResult));
    if (firstResult !== 'done') {
      setRun((cur) => (cur ? { ...cur, phase: 'stopped', states: { ...cur.states, ...Object.fromEntries(rest.map((id) => [id, 'skipped'])) } } : cur));
      toast.error(t('settings.remoteControl.v2.peerSwitch.batch.stopped'));
      return;
    }
    rest.forEach((id) => update(id, 'running'));
    const results = await Promise.all(rest.map(async (id) => {
      const result = await startRemoteSwitch(id, target);
      update(id, stateOf(result));
      return result;
    }));
    const all = [firstResult, ...results];
    const done = all.filter((r) => r === 'done').length;
    const notSwitched = all.length - done;
    setRun((cur) => (cur ? { ...cur, phase: 'finished' } : cur));
    if (notSwitched) toast.error(t('settings.remoteControl.v2.peerSwitch.batch.finishedWithRevert', { done, reverted: notSwitched }));
    else toast.success(t('settings.remoteControl.v2.peerSwitch.batch.finished', { done }));
  };

  const stateLabel = (state: ItemState) => t(`settings.remoteControl.v2.peerSwitch.batch.state.${state}`);
  const rowsBeforeRun = list.map((n) => {
    const a = answer(n.id);
    const text =
      a === 'ready'
        ? t('settings.remoteControl.v2.peerSwitch.batch.ready')
        : a === 'checking'
          ? t('settings.remoteControl.v2.peerSwitch.batch.checking')
          : t(`settings.remoteControl.v2.peerSwitch.batch.skipReason.${a}`);
    return (
      <li key={n.id} className="flex items-baseline justify-between gap-3 py-1 text-12">
        <span className={cn('min-w-0 truncate', a === 'ready' || a === 'checking' ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]')}>{n.name}</span>
        <span className="flex min-w-0 max-w-[65%] items-center gap-1.5 text-right text-[var(--text-tertiary)]">
          {a === 'checking' ? <Spinner size={11} aria-hidden /> : null}
          {text}
        </span>
      </li>
    );
  });
  const rowsDuringRun = run?.ids.map((id) => {
    const node = list.find((n) => n.id === id);
    const state = run.states[id];
    return (
      <li key={id} className="flex items-baseline justify-between gap-3 py-1 text-12">
        <span className="min-w-0 truncate text-[var(--text-primary)]">{node?.name ?? id}</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5',
            state === 'done' ? 'text-[var(--status-success)]' : state === 'reverted' || state === 'failed' ? 'text-[var(--error-fg)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          {state === 'running' ? <Spinner size={11} aria-hidden /> : state === 'done' ? <Check size={12} aria-hidden /> : null}
          {stateLabel(state)}
        </span>
      </li>
    );
  });

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-13 font-medium text-[var(--text-primary)]">
        {t(target === 'agent-net' ? 'settings.remoteControl.v2.peerSwitch.batch.confirmTitleAgentNet' : 'settings.remoteControl.v2.peerSwitch.batch.confirmTitleDeviceLink')}
      </div>
      <ul className="max-h-60 overflow-y-auto">{run ? rowsDuringRun : rowsBeforeRun}</ul>
      {run?.phase === 'stopped' ? (
        <p className="text-12 leading-[1.5] text-[var(--error-fg)]">{t('settings.remoteControl.v2.peerSwitch.batch.stopped')}</p>
      ) : (
        <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t(target === 'agent-net' ? 'settings.remoteControl.v2.peerSwitch.batch.canaryNote' : 'settings.remoteControl.v2.peerSwitch.batch.rollbackNote')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {run ? (
          <Button variant="secondary" size="sm" compact onClick={onClose} disabled={run.phase === 'running'}>
            {t('settings.remoteControl.v2.peerSwitch.batch.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" compact onClick={onClose}>
              {t('settings.remoteControl.v2.peerSwitch.batch.cancel')}
            </Button>
            <Button variant="primary" size="sm" compact disabled={checking || ready.length === 0} onClick={() => void start()}>
              {t('settings.remoteControl.v2.peerSwitch.batch.run', { count: ready.length })}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function RemoteSwitchBatch({ nodes, entries }: { nodes: readonly TopologyNode[]; entries: ReadonlyMap<string, RemoteSwitchEntry> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<RemoteSwitchTarget | null>(null);
  const toAgentNet = candidates(nodes, entries, 'agent-net').length;
  const toDeviceLink = candidates(nodes, entries, 'device-link').length;
  const trigger = (target: RemoteSwitchTarget, label: string) => (
    <Popover open={open === target} onOpenChange={(next) => setOpen(next ? target : null)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-12 text-[var(--text-secondary)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] hover:underline data-[state=open]:text-[var(--text-primary)]"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72 p-3">
        {open === target ? <BatchPanel target={target} nodes={nodes} entries={entries} onClose={() => setOpen(null)} /> : null}
      </PopoverContent>
    </Popover>
  );
  if (!toAgentNet && !toDeviceLink && !open) return null;
  return (
    <span className="flex items-center gap-3">
      {toAgentNet || open === 'agent-net' ? trigger('agent-net', t('settings.remoteControl.v2.peerSwitch.batch.toAgentNet')) : null}
      {toDeviceLink || open === 'device-link' ? trigger('device-link', t('settings.remoteControl.v2.peerSwitch.batch.toDeviceLink')) : null}
    </span>
  );
}
