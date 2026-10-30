/**
 * 伙伴的「主力电脑」入口（docs/product-rules/cloud-companions.md §3.1）：伙伴设置里的一行，以及聊天
 * 头部近况浮层的「电脑」块（BotGlancePopover）。任何一台电脑上都能看到伙伴在哪里运行，点开列出可以换去的电脑：
 * 本机是主力电脑时由本机交出；主力电脑在线时请它交出；主力电脑连不上时只能在这台电脑继续。
 * 确认后打开换过去的伙伴。服务器不支持云端伙伴时不出现。
 */
import { useRef, useState } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type {
  CompanionCloudFailureCode,
  CompanionCloudSnapshot,
  CompanionHomeChoices,
  CompanionSwitchOptions,
  CompanionTransferTarget,
} from '../../../shared/companionCloud';
import { ensureBotProfilesLoaded, useBotProfiles } from './botStore';
import {
  companionCloudApi,
  getCompanionCloudSnapshot,
  refreshCompanionCloud,
  useCompanionCloud,
} from './companionCloudStore';

const SWITCH_ERROR_KEYS: Record<CompanionCloudFailureCode, string> = {
  HOME_CONFLICT: 'bots.cloud.switchConflict',
  OFFLINE: 'bots.cloud.switchOffline',
  NOT_ENABLED: 'bots.cloud.notEnabled',
  TARGET_UNAVAILABLE: 'bots.cloud.targetUnavailable',
  FAILED: 'bots.cloud.switchFailed',
  BUSY: 'bots.cloud.transferBusy',
  HOME_OUTDATED: 'bots.cloud.homeOutdated',
  PAUSED: 'bots.cloud.resumeToMove',
};

/** How long a companion moved here from its online home may take to be built on this computer. */
const ARRIVAL_TIMEOUT_MS = 2 * 60_000;
const ARRIVAL_POLL_MS = 1_500;

export interface CompanionHomeBot {
  id: string;
  name: string;
  /** Local profile status; absent for companions read from another computer. */
  status?: string;
}

/** This computer runs the companion now: home here, the local copy built and no longer demoted. */
export function companionArrivedHere(cloud: CompanionCloudSnapshot, botId: string, localBotIds: readonly string[]): boolean {
  if (!cloud.enabled || !cloud.selfDeviceId || cloud.demotedBotIds.includes(botId)) return false;
  const actor = cloud.actors.find((candidate) => candidate.externalId === botId);
  return actor?.homeDeviceId === cloud.selfDeviceId && localBotIds.includes(botId);
}

/** Wait until the automatic take-over here finished (or time out). */
async function waitForArrival(botId: string, isCurrent: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  while (isCurrent() && Date.now() < deadline) {
    const profiles = await ensureBotProfilesLoaded(true).catch(() => []);
    const local = profiles.filter((profile) => profile.status === 'active').map((profile) => profile.id);
    if (companionArrivedHere(getCompanionCloudSnapshot(), botId, local)) return true;
    refreshCompanionCloud();
    await new Promise((resolve) => setTimeout(resolve, ARRIVAL_POLL_MS));
  }
  return false;
}

/** `inline`: the settings row shows failures under itself; `toast`: the 近况 popover has no room. */
export function useCompanionHomeSwitch(bot: CompanionHomeBot, failures: 'inline' | 'toast') {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const [choices, setChoices] = useState<CompanionHomeChoices | null>(null);
  const [choicesFailed, setChoicesFailed] = useState(false);
  const [pending, setPending] = useState<CompanionTransferTarget | null>(null);
  /** The companion was still working when asked to move there: wait for it, or stop it. */
  const [busyTarget, setBusyTarget] = useState<CompanionTransferTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const report = (message: string) => { if (failures === 'toast') toast.error(message); else setError(message); };
  const actor = cloud.enabled ? cloud.actors.find((candidate) => candidate.externalId === bot.id) : undefined;
  const home = actor?.homeDeviceId ?? null;
  const homeHere = !!home && home === cloud.selfDeviceId;
  const localStatus = useBotProfiles().find((profile) => profile.id === bot.id)?.status;
  // Only a running companion syncs (and so can move); a paused one is resumed first.
  const status = bot.status ?? (homeHere ? localStatus : undefined);
  const movable = status === undefined || status === 'active';
  const targetName = (target: CompanionTransferTarget) =>
    target.isSelf ? t('bots.cloud.thisComputer') : target.name.trim() || t('bots.cloud.unknownDevice');

  const load = () => {
    if (!movable) return;
    setChoices(null);
    setChoicesFailed(false);
    const api = companionCloudApi();
    if (!api) { setChoicesFailed(true); return; }
    const owner = getDataOwnerGeneration();
    void api.getCompanionHomeChoices(bot.id).then(
      (next) => { if (isDataOwnerGenerationCurrent(owner)) setChoices(next); },
      () => { if (isDataOwnerGenerationCurrent(owner)) setChoicesFailed(true); },
    );
  };

  const confirm = async (target: CompanionTransferTarget | null = pending, options?: CompanionSwitchOptions) => {
    if (!target || inFlight.current) return;
    const api = companionCloudApi();
    if (!api) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const device = targetName(target);
    const owner = getDataOwnerGeneration();
    const current = () => isDataOwnerGenerationCurrent(owner);
    try {
      if (options?.whenBusy === 'wait') toast.info(t('bots.cloud.waitingForTurn', { name: bot.name, device }));
      const result = await api.switchCompanionHome(bot.id, target.deviceId, options);
      if (!current()) return;
      setPending(null);
      setBusyTarget(null);
      // Still working and nothing chosen yet: offer to wait for the turn or stop it.
      if (!result.ok && result.code === 'BUSY' && !options?.whenBusy) {
        setBusyTarget(target);
        return;
      }
      if (!result.ok) {
        report(t(SWITCH_ERROR_KEYS[result.code] ?? 'bots.cloud.switchFailed', { name: bot.name, device }));
        refreshCompanionCloud();
        return;
      }
      if (!target.isSelf) {
        toast.info(t('bots.cloud.switched', { name: bot.name, device }));
        navigate(`/bots/remote/${encodeURIComponent(target.deviceId)}/${encodeURIComponent(bot.id)}`);
        return;
      }
      // Asked from another computer: this one builds the companion once the move reaches it.
      if (choices?.mode === 'remote') {
        toast.info(t('bots.cloud.takingOver', { name: bot.name }));
        if (!(await waitForArrival(bot.id, current))) {
          if (current()) toast.info(t('bots.cloud.arrivingLater', { name: bot.name }));
          return;
        }
      } else {
        await ensureBotProfilesLoaded(true).catch(() => undefined);
      }
      if (!current()) return;
      refreshCompanionCloud();
      navigate(`/bots/${encodeURIComponent(bot.id)}`);
    } catch {
      if (!current()) return;
      setPending(null);
      setBusyTarget(null);
      report(t('bots.cloud.switchFailed', { name: bot.name, device }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const homeName = homeHere
    ? t('bots.cloud.thisComputer')
    : actor?.homeDevice?.name?.trim() || t('bots.cloud.unknownDevice');
  return { actor, home, homeHere, homeName, movable, choices, choicesFailed, pending, setPending, busyTarget, setBusyTarget, busy,
    error, setError, inFlight, load, confirm, targetName };
}

export type HomeSwitch = ReturnType<typeof useCompanionHomeSwitch>;

function HomeMenuItems({ bot, state }: { bot: CompanionHomeBot; state: HomeSwitch }) {
  const { t } = useTranslation();
  const { choices } = state;
  if (!state.movable)
    return <DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.resumeToMove', { name: bot.name })}</DropdownMenuItem>;
  if (state.choicesFailed) return <DropdownMenuItem disabled>{t('bots.cloud.devicesFailed')}</DropdownMenuItem>;
  if (choices === null) return <DropdownMenuItem disabled>{t('bots.cloud.loadingDevices')}</DropdownMenuItem>;
  if (choices.mode === 'unavailable')
    return (
      <DropdownMenuItem disabled className="whitespace-normal">
        {choices.reason === 'HOME_OUTDATED'
          ? t('bots.cloud.homeOutdated', { name: bot.name, device: state.homeName })
          : t('bots.cloud.notEnabled')}
      </DropdownMenuItem>
    );
  const hereOff = choices.thisComputer === 'REMOTE_CONTROL_OFF'
    ? <DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.hereControlOff')}</DropdownMenuItem> : null;
  if (choices.targets.length === 0)
    return <><DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.noTargets')}</DropdownMenuItem>{hereOff}</>;
  return (
    <>
      {choices.targets.map((target) => (
        <DropdownMenuItem key={target.deviceId} onSelect={() => { state.setError(null); state.setPending(target); }}>
          <span className="min-w-0 truncate">
            {target.isSelf ? t('bots.cloud.switchHere') : t('bots.cloud.switchTo', { device: state.targetName(target) })}
          </span>
        </DropdownMenuItem>
      ))}
      {hereOff}
    </>
  );
}

export function HomeSwitchConfirm({ bot, state }: { bot: CompanionHomeBot; state: HomeSwitch }) {
  const { t } = useTranslation();
  const device = state.pending ? state.targetName(state.pending) : '';
  const busyDevice = state.busyTarget ? state.targetName(state.busyTarget) : '';
  return (
    <>
    <ConfirmDialog
      open={state.busyTarget !== null}
      presentation="standard"
      cancelFirst
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setBusyTarget(null); }}
      title={t('bots.cloud.busyTitle', { name: bot.name })}
      description={t('bots.cloud.busyDescription', { name: bot.name, device: busyDevice })}
      confirmText={t('bots.cloud.busyWait')}
      tertiaryText={t('bots.cloud.busyStop')}
      cancelText={t('bots.cancel')}
      loading={state.busy}
      onConfirm={() => void state.confirm(state.busyTarget, { whenBusy: 'wait' })}
      onTertiary={() => void state.confirm(state.busyTarget, { whenBusy: 'stop' })}
    />
    <ConfirmDialog
      open={state.pending !== null}
      presentation="standard"
      cancelFirst
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setPending(null); }}
      title={t('bots.cloud.switchTitle', { name: bot.name, device })}
      description={t('bots.cloud.switchDescription', { name: bot.name, device })}
      confirmText={t('bots.cloud.switchAction', { device })}
      cancelText={t('bots.cancel')}
      loading={state.busy}
      onConfirm={() => void state.confirm()}
    />
    </>
  );
}

/** The 「主力电脑」 row in a companion's settings, on any computer. */
export function BotHomeComputerSetting({ bot, className = 'mt-3' }: { bot: CompanionHomeBot; className?: string }) {
  const { t } = useTranslation();
  const state = useCompanionHomeSwitch(bot, 'inline');
  if (!state.actor || !state.home) return null;
  return (
    <div className={className}>
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <DropdownMenu onOpenChange={(open) => { if (open) state.load(); }}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="bot-home-computer-row"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
            >
              <Monitor size={18} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1">{t('bots.cloud.homeLabel')}</span>
              <span className="min-w-0 max-w-48 truncate text-13 text-[var(--text-secondary)]">{state.homeName}</span>
              <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56 max-w-80">
            <HomeMenuItems bot={bot} state={state} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {state.error ? (
        <p role="alert" className="mt-2 px-1 text-12 text-[var(--text-danger)]">{state.error}</p>
      ) : null}
      <HomeSwitchConfirm bot={bot} state={state} />
    </div>
  );
}
