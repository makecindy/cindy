/**
 * 伙伴的「主力电脑」入口（docs/product-rules/cloud-companions.md §3.1）：伙伴设置里的一行，以及聊天
 * 头部近况浮层的「电脑」块（BotGlancePopover）。任何一台电脑上都能看到伙伴在哪里运行，点开列出可以换去的电脑：
 * 本机是主力电脑时由本机交出；主力电脑在线时请它交出；主力电脑连不上时只能在这台电脑继续。
 * 确认后打开换过去的伙伴。服务器不支持云端伙伴时不出现。
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CompanionCindyConflictAction, useCompanionCindyConflictAction } from './CompanionCindyConflictAction';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { CompanionProfileRepairDialog } from './CompanionProfileRepairDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast, type ToastAction } from '@/lib/toast';
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
  LOCAL_CINDY_CONFLICT: 'bots.cloud.localCindyConflict',
  OFFLINE: 'bots.cloud.switchOffline',
  NOT_ENABLED: 'bots.cloud.notEnabled',
  TARGET_UNAVAILABLE: 'bots.cloud.targetUnavailable',
  FAILED: 'bots.cloud.switchFailed',
  BUSY: 'bots.cloud.transferBusy',
  HOME_OUTDATED: 'bots.cloud.homeOutdated',
  PAUSED: 'bots.cloud.resumeToMove',
  TARGET_OUTDATED: 'bots.cloud.targetOutdated',
  SKILL_TARGET_OUTDATED: 'bots.cloud.skillTargetOutdated',
  PROFILE_SNAPSHOT_MISSING: 'bots.cloud.missingProfileFailed',
  // Answered with the force-take-over dialog instead (`forceTarget`); kept for completeness.
  HOME_UNRESPONSIVE: 'bots.cloud.switchOffline',
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
async function waitForArrival(botId: string, isCurrent: () => boolean): Promise<boolean | NonNullable<CompanionCloudSnapshot['actors'][number]['profileFailure']>> {
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  while (isCurrent() && Date.now() < deadline) {
    const profiles = await ensureBotProfilesLoaded(true).catch(() => []);
    const local = profiles.filter((profile) => profile.status === 'active').map((profile) => profile.id);
    const cloud = getCompanionCloudSnapshot();
    const failure = cloud.actors.find(actor => actor.externalId === botId)?.profileFailure;
    if (failure) return failure;
    if (companionArrivedHere(cloud, botId, local)) return true;
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
  const conflict = useCompanionCindyConflictAction();
  /**
   * The latest read of the home choices, for the companion it was asked for: in flight, answered or failed.
   * A result for another companion, or from an earlier request, never shows (see `load`).
   */
  const [homeRead, setHomeRead] = useState<{ botId: string; pending: boolean; choices: CompanionHomeChoices | null; failed: boolean } | null>(null);
  const homeReadSeq = useRef(0);
  // Switching companions or unmounting retires the request in flight: its late result is dropped.
  useEffect(() => () => { homeReadSeq.current += 1; }, [bot.id]);
  const currentRead = homeRead?.botId === bot.id ? homeRead : null;
  const choices = currentRead?.choices ?? null;
  const choicesFailed = !!currentRead?.failed;
  const [pending, setPending] = useState<CompanionTransferTarget | null>(null);
  /** The companion was still working when asked to move there: wait for it, or stop it. */
  const [busyTarget, setBusyTarget] = useState<CompanionTransferTarget | null>(null);
  /** The home's state could not be confirmed (no explicit answer): the owner may take it over here anyway. */
  const [forceTarget, setForceTarget] = useState<CompanionTransferTarget | null>(null);
  /**
   * The home the force dialog is about, id and name from the same decision (the probe's choices or the
   * switch result), never the live snapshot: the warning names the computer the force is submitted for.
   */
  const [forceHome, setForceHome] = useState<{ id: string; name: string | null } | null>(null);
  /** The home a decision saw, named from that same decision (null when it had no name). */
  const decidedHome = (id: string | null | undefined, name: string | undefined) =>
    id ? { id, name: name?.trim() || null } : null;
  /** Text options naming that home; without a name, the `_unnamed` text (never a placeholder name in the sentence). */
  const homeText = (name: string | null | undefined) => (name ? { device: name } : { context: 'unnamed' as const });
  const askForce = (target: CompanionTransferTarget, home: { id: string; name: string | null } | null) => { setForceHome(home); setForceTarget(target); };
  /** Another computer never uploaded a profile snapshot: ask before starting fresh here. */
  const [missingProfileTarget, setMissingProfileTarget] = useState<CompanionTransferTarget | null>(null);
  /**
   * The missing-profile confirmation follows a forced take-over: confirming it keeps the force, still
   * bound to the home the owner confirmed (a home changed in between is refused as HOME_CONFLICT).
   */
  const missingProfileForceHome = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairAvailable, setRepairAvailable] = useState(false);
  const inFlight = useRef(false);
  const report = (message: string, action?: ToastAction) => { if (failures === 'toast') toast.error(message, { action }); else setError(message); };
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
    const botId = bot.id;
    const request = ++homeReadSeq.current;
    const api = companionCloudApi();
    if (!api) { setHomeRead({ botId, pending: false, choices: null, failed: true }); return; }
    setHomeRead({ botId, pending: true, choices: null, failed: false });
    const owner = getDataOwnerGeneration();
    const settle = (next: { choices: CompanionHomeChoices | null; failed: boolean }) => {
      if (isDataOwnerGenerationCurrent(owner) && request === homeReadSeq.current) setHomeRead({ botId, pending: false, ...next });
    };
    void api.getCompanionHomeChoices(botId).then(
      (next) => settle({ choices: next, failed: false }),
      () => settle({ choices: null, failed: true }),
    );
  };

  const confirm = async (target: CompanionTransferTarget | null = pending, options?: CompanionSwitchOptions) => {
    if (!target || inFlight.current) return;
    const api = companionCloudApi();
    if (!api) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setRepairAvailable(false);
    conflict.clear();
    const device = targetName(target);
    const owner = getDataOwnerGeneration();
    const current = () => isDataOwnerGenerationCurrent(owner);
    try {
      if (options?.whenBusy === 'wait') toast.info(t('bots.cloud.waitingForTurn', { name: bot.name, device }));
      const result = await api.switchCompanionHome(bot.id, target.deviceId, options);
      if (!current()) return;
      setPending(null);
      setBusyTarget(null);
      setForceTarget(null);
      setMissingProfileTarget(null);
      // The home did not answer (not offline): never a silent take-over, the owner decides.
      if (!result.ok && result.code === 'HOME_UNRESPONSIVE' && !options?.force) {
        askForce({ deviceId: cloud.selfDeviceId ?? target.deviceId, name: '', online: true, isSelf: true }, decidedHome(result.homeDeviceId, result.homeName));
        return;
      }
      // Still working and nothing chosen yet: offer to wait for the turn or stop it.
      if (!result.ok && result.code === 'BUSY' && !options?.whenBusy) {
        setBusyTarget(target);
        return;
      }
      if (!result.ok && result.code === 'PROFILE_SNAPSHOT_MISSING' && !options?.allowMissingProfile) {
        missingProfileForceHome.current = options?.force ? options.forceHomeDeviceId ?? null : null;
        setMissingProfileTarget(target);
        return;
      }
      if (!result.ok) {
        setRepairAvailable(!!result.profileFailure);
        report(result.profileFailure ? t(result.profileFailure.field === 'identitySource' ? 'bots.cloud.profileIdentityTooLong' : 'bots.cloud.profileUserTooLong', { limit: result.profileFailure.maxLength })
          // Own keys only: a code relayed from another computer is untrusted text (`constructor`, `__proto__`…).
          : t(Object.hasOwn(SWITCH_ERROR_KEYS, result.code) ? SWITCH_ERROR_KEYS[result.code] : 'bots.cloud.switchFailed', {
            name: bot.name, device, context: result.oversizedSkill ? 'skill' : undefined, ...result.oversizedSkill,
          }),
          result.profileFailure ? { label: t('bots.cloud.repair.action'), onClick: () => setRepairOpen(true) } : conflict.report(result));
        refreshCompanionCloud();
        return;
      }
      if (!target.isSelf) {
        toast.info(t('bots.cloud.switched', { name: bot.name, device }));
        navigate(`/bots/remote/${encodeURIComponent(target.deviceId)}/${encodeURIComponent(bot.id)}`);
        return;
      }
      // Asked from another computer (or forced while it may have answered meanwhile): this one
      // builds the companion once the move reaches it.
      if (choices?.mode === 'remote' || options?.force) {
        toast.info(t('bots.cloud.takingOver', { name: bot.name }));
        const arrival = await waitForArrival(bot.id, current);
        if (!current()) return;
        if (typeof arrival === 'object') {
          report(t(arrival.field === 'identitySource' ? 'bots.cloud.profileIdentityTooLong' : 'bots.cloud.profileUserTooLong', { limit: arrival.maxLength }));
          navigate(`/bots/remote/${encodeURIComponent(target.deviceId)}/${encodeURIComponent(bot.id)}`);
          return;
        }
        if (!arrival) {
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
      setForceTarget(null);
      setMissingProfileTarget(null);
      report(t('bots.cloud.switchFailed', { name: bot.name, device }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const homeName = homeHere
    ? t('bots.cloud.thisComputer')
    : actor?.homeDevice?.name?.trim() || t('bots.cloud.unknownDevice');
  /**
   * Opening the menu or the 近况 popover asks the home (another computer) about its state before any choice
   * is shown, and a confirmation asks it again: say so while it runs (cloud-companions.md §3.1).
   */
  const checkingHome = !!currentRead?.pending && movable && !homeHere && !!home;
  /**
   * Whether the companion is known to run on its home, from confirmed facts only (cloud-companions.md §3.1):
   * only a local companion that is active. Another computer's answer is about that computer's Cindy (its
   * version and the computers it can hand over to), never about this companion: the request carries no
   * companion and the answer no companion state (#11999 review). So a remote home is never shown as running.
   */
  const homeRunning = homeHere && status === 'active';
  /** The home's own name for that line (null: the unnamed wording, never a placeholder name). */
  const checkingName = homeHere ? null : actor?.homeDevice?.name?.trim() || null;
  return { actor, home, homeHere, homeName, checkingHome, homeRunning, checkingName, movable, choices, choicesFailed, pending, setPending, busyTarget, setBusyTarget,
    forceTarget, setForceTarget, forceHome, askForce, decidedHome, homeText, missingProfileTarget, setMissingProfileTarget, missingProfileForceHome, busy,
    error, setError, inFlight, load, confirm, targetName, conflictAction: conflict.action, repairOpen, setRepairOpen, repairAvailable };
}

export type HomeSwitch = ReturnType<typeof useCompanionHomeSwitch>;

function HomeMenuItems({ bot, state }: { bot: CompanionHomeBot; state: HomeSwitch }) {
  const { t } = useTranslation();
  const { choices } = state;
  if (!state.movable)
    return <DropdownMenuItem disabled className="whitespace-normal">{t('bots.cloud.resumeToMove', { name: bot.name })}</DropdownMenuItem>;
  if (state.choicesFailed) return <DropdownMenuItem disabled>{t('bots.cloud.devicesFailed')}</DropdownMenuItem>;
  if (choices === null && state.checkingHome)
    return (
      <DropdownMenuItem disabled className="gap-2 whitespace-normal">
        <Spinner size={14} aria-hidden className="shrink-0" />
        <span role="status" className="min-w-0">{t('bots.cloud.checkingHome', state.homeText(state.checkingName))}</span>
      </DropdownMenuItem>
    );
  if (choices === null) return <DropdownMenuItem disabled>{t('bots.cloud.loadingDevices')}</DropdownMenuItem>;
  if (choices.mode === 'unavailable')
    return (
      <DropdownMenuItem disabled className="whitespace-normal">
        {choices.reason === 'HOME_OUTDATED'
          ? t('bots.cloud.homeOutdated', { name: bot.name, device: state.homeName })
          : t('bots.cloud.notEnabled')}
      </DropdownMenuItem>
    );
  // Listed online but not answering: say so, and only offer an explicit forced take-over here.
  if (choices.reason === 'HOME_UNRESPONSIVE')
    return (
      <>
        <DropdownMenuItem disabled className="whitespace-normal">
          {t('bots.cloud.homeUnresponsive', { name: bot.name, ...state.homeText(state.decidedHome(choices.homeDeviceId, choices.homeName)?.name) })}
        </DropdownMenuItem>
        {/* May lose what that computer has not synced: a destructive row (DESIGN.md §4 Destructive actions). */}
        {choices.targets.filter((target) => target.isSelf).map((target) => (
          // A destructive action's label wraps instead of being cut off (long in some languages).
          <DropdownMenuItem key={target.deviceId} variant="danger" className="whitespace-normal" onSelect={() => { state.setError(null); state.askForce(target, state.decidedHome(choices.homeDeviceId, choices.homeName)); }}>
            <span className="min-w-0">{t('bots.cloud.forceHere')}</span>
          </DropdownMenuItem>
        ))}
      </>
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
            {target.isSelf ? t('bots.cloud.switchHere')
              // An older Cindy: it can take the teammate, which then runs there the older way.
              : t(target.outdated ? 'bots.cloud.targetOutdatedItem' : 'bots.cloud.switchTo', { device: state.targetName(target) })}
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
  /**
   * While a confirmation runs, the home (another computer) is asked about its state again: say so. A
   * confirmed force asks it once, briefly; every other confirmation asks in full (cloud-companions.md §3.1).
   */
  const checkingNote = (forced: boolean) => state.busy && !state.homeHere
    ? <p role="status" className="text-base text-[var(--confirm-desc)]">{t(forced ? 'bots.cloud.checkingHomeForced' : 'bots.cloud.checkingHomeWait')}</p>
    : undefined;
  return (
    <>
    <CompanionProfileRepairDialog botId={bot.id} open={state.repairOpen} onOpenChange={state.setRepairOpen} />
    <ConfirmDialog
      open={state.busyTarget !== null}
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setBusyTarget(null); }}
      title={t('bots.cloud.busyTitle', { name: bot.name })}
      description={t('bots.cloud.busyDescription', { name: bot.name, device: busyDevice })}
      confirmText={t('bots.cloud.busyWait')}
      tertiaryText={t('bots.cloud.busyStop')}
      cancelText={t('bots.cancel')}
      content={checkingNote(false)}
      loading={state.busy}
      onConfirm={() => void state.confirm(state.busyTarget, { whenBusy: 'wait' })}
      onTertiary={() => void state.confirm(state.busyTarget, { whenBusy: 'stop' })}
    />
    <ConfirmDialog
      open={state.forceTarget !== null}
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setForceTarget(null); }}
      title={t('bots.cloud.forceTitle', state.homeText(state.forceHome?.name))}
      description={t('bots.cloud.forceDescription', { name: bot.name, ...state.homeText(state.forceHome?.name) })}
      confirmText={t('bots.cloud.forceAction')}
      confirmVariant="destructive"
      cancelText={t('bots.cloud.forceLater')}
      content={checkingNote(!!state.forceHome)}
      loading={state.busy}
      onConfirm={() => void state.confirm(state.forceTarget, state.forceHome ? { force: true, forceHomeDeviceId: state.forceHome.id } : undefined)}
    />
    <ConfirmDialog
      open={state.missingProfileTarget !== null}
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setMissingProfileTarget(null); }}
      title={t('bots.cloud.missingProfileTitle', { name: bot.name })}
      description={t('bots.cloud.missingProfileDescription', { name: bot.name })}
      confirmText={t('bots.cloud.missingProfileConfirm')}
      cancelText={t('bots.cancel')}
      content={checkingNote(!!state.missingProfileForceHome.current)}
      loading={state.busy}
      // After a forced take-over (home state not confirmed) keep the force, or the move asks again.
      onConfirm={() => {
        const forcedHome = state.missingProfileForceHome.current;
        void state.confirm(state.missingProfileTarget, { allowMissingProfile: true, ...(forcedHome ? { force: true, forceHomeDeviceId: forcedHome } : {}) });
      }}
    />
    <ConfirmDialog
      open={state.pending !== null}
      onOpenChange={(open) => { if (!open && !state.inFlight.current) state.setPending(null); }}
      title={t('bots.cloud.switchTitle', { name: bot.name, device })}
      description={t('bots.cloud.switchDescription', { name: bot.name, device })}
      // An older Cindy there: say what the teammate keeps and what does not apply.
      content={state.pending?.outdated || checkingNote(false) ? (
        <div className="space-y-2">
          {state.pending?.outdated ? <p className="text-base text-[var(--confirm-desc)]">{t('bots.cloud.olderTargetNote', { name: bot.name, device })}</p> : null}
          {checkingNote(false)}
        </div>
      ) : undefined}
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
      {state.error ? <CompanionCindyConflictAction action={state.conflictAction} /> : null}
      {state.repairAvailable && state.error && <Button variant="secondary" size="md" className="mt-2" onClick={() => state.setRepairOpen(true)}>{t('bots.cloud.repair.action')}</Button>}
      <HomeSwitchConfirm bot={bot} state={state} />
    </div>
  );
}
