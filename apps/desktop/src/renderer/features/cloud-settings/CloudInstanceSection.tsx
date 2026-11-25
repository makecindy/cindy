import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Clock3, Moon, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import {
  SETTINGS_HINT,
  SETTINGS_ROW_LABEL_CLASS,
  SettingsBlock,
  SettingsCard,
  SettingsPageHeader,
  SettingsRow,
} from '@/components/ui/settings-rows';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  cloudMaintenanceEditSchema,
  type CloudMaintenanceEdit,
  type CloudInstanceView,
  type CloudMaintenanceView,
  type CloudMaintenanceCalendar,
} from '../../../shared/cloudInstanceControl';
import type { CloudSettingsClient } from './client';
import { cloudRefusalKey } from './refusal';
import { COMMON_TIMEZONES, shortOffset, timezoneOffset } from './timezones';
import { SETTLE_DELAYS_MS, useSettleUnknown } from './useSettleUnknown';
import { InlineRetry } from './blockRetry';
import {
  stableInstanceState as stableState,
  instanceStatus,
  canRequestUpgrade,
  upgradeOutcome,
} from './instanceState';

const label = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const description = 'text-12 leading-[1.5] text-[var(--settings-section-desc)]';
// Inside a My devices card: standard settings rows, in an inset block like "Allow remote desktop".
const embeddedLabel = SETTINGS_ROW_LABEL_CLASS;
const embeddedDescription = SETTINGS_HINT;
const embeddedBox =
  'flex flex-col divide-y divide-[var(--border-default)] rounded-lg bg-[var(--settings-input-bg)] px-3 [&>*]:py-3';
const Embedded = createContext(false);
/** A block of instance rows: the inset block inside a My devices card, otherwise a settings card. */
function InstanceBox({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return embedded ? (
    <div className={embeddedBox}>{children}</div>
  ) : (
    <SettingsCard className="flex flex-col gap-4 p-5">{children}</SettingsCard>
  );
}
function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  const embedded = useContext(Embedded);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* Keeps a readable text width: on a narrow screen the action moves under it instead. */}
      <div className="min-w-0 flex-1 basis-40">
        <p className={embedded ? embeddedLabel : label}>{title}</p>
        {detail && (
          <p className={`${embedded ? embeddedDescription : description} ${embedded ? 'mt-0.5' : 'mt-1'}`}>
            {detail}
          </p>
        )}
      </div>
      <div className="flex max-w-full shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
/**
 * The update hours dropdown's value: the default, every day for two hours from a whole hour in
 * this computer's time zone ('h0'…'h23'), or a saved custom schedule none of those describes.
 */
type ScheduleChoice = 'inherit' | 'keep' | `h${number}`;
type Draft = {
  autoUpdate: boolean;
  mode: 'inherit' | 'custom';
  calendar: CloudMaintenanceCalendar;
  choice: ScheduleChoice;
  base: CloudMaintenanceView;
};
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const hour = (value: number) => `${String(value % 24).padStart(2, '0')}:00`;
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/** One window every day, two hours from a whole hour; CIS accepts 1–6 hours, across midnight too. */
const dailyCalendar = (start: number, timezone: string): CloudMaintenanceCalendar => ({
  timezone,
  windows: [{ id: 'daily', weekdays: EVERY_DAY, startLocal: hour(start), endLocal: hour(start + 2) }],
});
/** A calendar's start hour when it is one window, every day, two hours from a whole hour. */
function dailyStart(calendar: CloudMaintenanceCalendar): number | null {
  const [rule] = calendar.windows;
  if (calendar.windows.length !== 1 || !rule || rule.weekdays.length !== 7) return null;
  if (!/^\d\d:00$/.test(rule.startLocal)) return null;
  const start = Number(rule.startLocal.slice(0, 2));
  return rule.endLocal === hour(start + 2) ? start : null;
}
const offsetMinutes = (zone: string) => {
  const match = /UTC([+-])(\d\d):(\d\d)/.exec(timezoneOffset(zone));
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
};
/** CIS gives the default only while the instance follows it; otherwise its usual 03:00–05:00. */
const defaultCalendarOf = (base: CloudMaintenanceView, timezone: string) =>
  base.effective.source === 'inherit' ? base.effective.calendar : dailyCalendar(3, timezone);
/**
 * The daily option the default schedule equals in this computer's time zone, if any: it is not
 * offered twice.
 */
function defaultHour(base: CloudMaintenanceView, timezone: string): number | null {
  const calendar = defaultCalendarOf(base, timezone);
  const start = dailyStart(calendar);
  const shift = offsetMinutes(timezone) - offsetMinutes(calendar.timezone);
  return start === null || shift % 60 ? null : (((start + shift / 60) % 24) + 24) % 24;
}
function scheduleChoice(base: CloudMaintenanceView, timezone: string): ScheduleChoice {
  if (base.raw.policyMode === 'inherit') return 'inherit';
  const calendar = base.raw.calendar ?? base.effective.calendar;
  const start = calendar.timezone === timezone ? dailyStart(calendar) : null;
  if (start === null) return 'keep';
  // A custom schedule that is the default shows as the default; it stays custom until changed.
  return start === defaultHour(base, timezone) ? 'inherit' : `h${start}`;
}
/**
 * The state a Remote connections device card already holds: the card's list polling keeps it
 * current, so an embedded section does not poll on its own.
 */
export type CloudInstanceFeed = {
  view: CloudInstanceView;
  /** Re-reads the instance now; rejects when the read fails. */
  reload(): Promise<void>;
  onPolicySaved(policy: CloudMaintenanceView): void;
  /** DeviceLink does not have the instance: during an update it is restarting. */
  linkOffline?: boolean;
  /** An update was just requested: the card reads its list more often for a while. */
  hurry?(): void;
};
/** After 立即更新, the instance is read every 2 s for 30 s, so 已安排 turns into 正在更新 soon. */
export const HURRY_POLL_MS = 2_000;
export const HURRY_FOR_MS = 30_000;
const fromPolicy = (base: CloudMaintenanceView): Draft => ({
  base,
  autoUpdate: base.autoUpdate,
  mode: base.raw.policyMode,
  calendar: structuredClone(base.raw.calendar ?? base.effective.calendar),
  choice: scheduleChoice(base, localTimezone()),
});
/** Unsaved only when the switch, the dropdown or the policy mode differs from the saved policy. */
const draftDirty = (draft: Draft) =>
  draft.autoUpdate !== draft.base.autoUpdate ||
  draft.choice !== scheduleChoice(draft.base, localTimezone()) ||
  draft.mode !== draft.base.raw.policyMode;

/** A read policy holds the change: the same switch, mode and (for a custom one) calendar. */
const policyMatches = (policy: CloudMaintenanceView, change: CloudMaintenanceEdit) =>
  policy.autoUpdate === change.autoUpdate &&
  policy.raw.policyMode === change.policyMode &&
  (change.policyMode !== 'custom' ||
    JSON.stringify(policy.raw.calendar) === JSON.stringify(change.calendar));

/** Lifecycle and policy use the CIS control plane, including while the Host sleeps. */
export function CloudInstanceSection({
  client,
  name,
  active,
  changed,
  focusMaintenance = false,
  embedded = false,
  feed,
  dialog,
}: {
  client: CloudSettingsClient;
  name: string;
  active: boolean;
  changed(domain: string, dirty: boolean): void;
  focusMaintenance?: boolean;
  /**
   * Inside a Remote connections device card, which already shows the name, the lifecycle
   * state and sleep/wake: render only versions, upgrade and maintenance.
   */
  embedded?: boolean;
  feed?: CloudInstanceFeed;
  /**
   * Inside the card's update dialog: the version state on top, changes save as they are made,
   * and Done goes to the dialog's footer. The switch takes focus when it appears.
   */
  dialog?: { footer: HTMLElement | null; onCancel(): void };
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [view, setView] = useState<CloudInstanceView>();
  const maintenanceTarget = useRef<HTMLElement>(null);
  const locatedMaintenance = useRef(false);
  useEffect(() => {
    if (focusMaintenance && active && view && !locatedMaintenance.current) {
      maintenanceTarget.current?.scrollIntoView?.({ block: 'start' });
      locatedMaintenance.current = true;
    }
  }, [focusMaintenance, active, !!view]);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  /** A refused or failed request is a toast, as the local About page does. */
  const failToast = (key: string) =>
    toast.error(t(`cloudSettings.instance.${key}`));
  /** What became of the last automatic save: said in a toast, not under the dropdown. */
  const setPolicyNote = (note: string | undefined) => {
    if (note) failToast(note);
  };
  const alive = useRef(true),
    inFlight = useRef(false),
    dirty = useRef(false),
    uncertain = useRef(false);
  const blocked = useRef(false);
  const fed = !!feed;
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const tr = (key: string, values?: Record<string, string>) =>
    t(`cloudSettings.instance.${key}`, values);
  const mark = useCallback(
    (value: boolean) => {
      dirty.current = value;
      changed('instance', value);
    },
    [changed],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(
    async (explicit = false) => {
      if (inFlight.current || (!feedRef.current && !client.instance)) return;
      if (!explicit && uncertain.current) return;
      inFlight.current = true;
      if (explicit) setBusy(true);
      try {
        if (feedRef.current) await feedRef.current.reload();
        else {
          const next = await client.instance!();
          if (!alive.current) return;
          setView(next);
          if (!dirty.current) setDraft(next.maintenance ? fromPolicy(next.maintenance) : undefined);
        }
        if (!alive.current) return;
        blocked.current = false;
        if (explicit) {
          uncertain.current = false;
          setError(undefined);
        }
      } catch {
        if (alive.current) {
          blocked.current = true;
          setError('readFailed');
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [client],
  );
  // An upgrade, sleep or wake with an unknown result is read back from the instance,
  // never requested again. What a read found replaces the unknown state.
  const readInstance = async () => {
    const next = await client.instance!();
    if (alive.current) {
      setView(next);
      if (!dirty.current) setDraft(next.maintenance ? fromPolicy(next.maintenance) : undefined);
    }
    return next;
  };
  // Not started (refused before it was sent, or not found started): a toast; the button stays.
  const setNotStarted = (notStarted: boolean) => {
    if (notStarted) failToast('upgradeNotStarted');
  };
  const [submitting, setSubmitting] = useState(false);
  const [notTaken, setNotTaken] = useState<'wake' | 'sleep'>();
  const upgradeCheck = useSettleUnknown<number>({
    delays: SETTLE_DELAYS_MS.upgrade,
    // Started: an upgrade under way, or one CIS updated after this request was made.
    check: async (submittedAt) => {
      const operation = (await readInstance()).upgradeOperation;
      return operation && (operation.active || operation.updatedAtMs > submittedAt)
        ? 'done'
        : 'notDone';
    },
    onSettled: (verdict) => {
      if (!alive.current) return;
      if (verdict === 'done') {
        client.upgradeSettled?.();
        void feedRef.current?.reload();
      } else setNotStarted(true);
    },
  });
  const powerCheck = useSettleUnknown<'wake' | 'sleep'>({
    delays: SETTLE_DELAYS_MS.power,
    check: async (action) =>
      (await readInstance()).desiredState === (action === 'wake' ? 'running' : 'stopped')
        ? 'done'
        : 'notDone',
    onSettled: (verdict, action) => {
      if (!alive.current) return;
      if (verdict === 'done') setMessage(action === 'wake' ? 'wakeSent' : 'sleepSent');
      else setNotTaken(action);
    },
  });
  const unreadable =
    upgradeCheck.state === 'unreadable'
      ? { reload: upgradeCheck.reload }
      : powerCheck.state === 'unreadable' && powerCheck.context
        ? { reload: powerCheck.reload }
        : undefined;
  // Just after 立即更新: read more often for a while (the card does it for a fed section).
  const [hurrying, setHurrying] = useState(false);
  useEffect(() => {
    if (!hurrying) return;
    const timer = setTimeout(() => setHurrying(false), HURRY_FOR_MS);
    return () => clearTimeout(timer);
  }, [hurrying]);
  // Fed from the card: take what its list and policy reads last returned.
  const fedView = feed?.view;
  useEffect(() => {
    if (!fedView) return;
    setView(fedView);
    if (!dirty.current)
      setDraft(fedView.maintenance ? fromPolicy(fedView.maintenance) : undefined);
  }, [fedView]);
  useEffect(() => {
    if (!active) return;
    void refresh(true);
    if (fed) return;
    const poll = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const timer = setInterval(
      poll,
      hurrying ? HURRY_POLL_MS : view && !stableState(view) ? 5000 : 30000,
    );
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [active, client, fed, refresh, !fed && view ? stableState(view) : true, hurrying]);
  // The switch and the dropdown save as soon as they change.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const update = (patch: Partial<Draft>) => {
    const current = draftRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
    setPolicyNote(undefined);
    if (draftDirty(next)) {
      mark(true);
      void persist();
    }
  };
  const replaceConfirmation = () => ({
    title: tr('replaceTitle'),
    description: tr('replaceBody'),
    confirmText: tr('replaceConfirm'),
  });
  // Back on the saved choice, the saved calendar returns exactly: saving never rewrites it.
  const choose = async (choice: ScheduleChoice) => {
    if (!draft || choice === draft.choice) return;
    // Only several custom windows cannot be chosen again here: replacing them asks first.
    if (draft.choice === 'keep' && !(await confirm(replaceConfirmation()))) return;
    if (!alive.current) return;
    const saved = fromPolicy(draft.base);
    update(
      // A saved custom schedule that equals the default shows as the default: choosing the
      // default again (after another option) is what makes it follow the default.
      choice === 'inherit' && saved.mode === 'custom' && draft.choice !== 'inherit'
        ? { choice, mode: 'inherit' }
        : choice === saved.choice || choice === 'keep'
        ? { choice: saved.choice, mode: saved.mode, calendar: saved.calendar }
        : choice === 'inherit'
          ? { choice, mode: 'inherit' }
          : { choice, mode: 'custom', calendar: dailyCalendar(Number(choice.slice(1)), localTimezone()) },
    );
  };
  const reload = async () => {
    if (inFlight.current) return;
    if (
      dirty.current &&
      !(await confirm({
        // The client's reload-with-unsaved-changes confirm (RemoteBotSettings).
        title: t('bots.memory.unsavedTitle'),
        description: t('bots.remoteSettings.discardDescription'),
        confirmText: t('bots.memory.discard'),
        cancelText: t('bots.memory.continueEditing'),
      }))
    )
      return;
    if (!alive.current) return;
    mark(false);
    setMessage(undefined);
    await refresh(true);
  };
  const power = async () => {
    if (
      inFlight.current ||
      blocked.current ||
      uncertain.current ||
      powerCheck.state ||
      !view ||
      !client.power
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage(undefined);
    setNotTaken(undefined);
    let unknown = false;
    const action = view.desiredState === 'stopped' ? 'wake' : 'sleep';
    try {
      if (
        action === 'sleep' &&
        !(await confirm({
          title: tr('sleepTitle', { name: view.name || name }),
          description: t('cloudSettings.instance.sleepBody', { name: view.name || name }),
          confirmText: tr('sleepConfirm'),
          autoFocusConfirm: true,
        }))
      )
        return;
      if (!alive.current) return;
      await client.power(action);
      if (alive.current) setMessage(action === 'wake' ? 'wakeSent' : 'sleepSent');
    } catch (cause) {
      if (alive.current) {
        // A refusal certainly changed nothing: it says why, and is not read back.
        const refusal = cloudRefusalKey(cause);
        if (refusal) setError(refusal);
        else {
          unknown = true;
          void powerCheck.start(action);
        }
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setBusy(false);
        if (!unknown) await refresh();
      }
    }
  };
  const upgradeConfirmation = (instance: CloudInstanceView) => ({
    title: tr('upgradeConfirmTitle', { name: instance.name || name }),
    // As the local Agent update: what happens, and the versions, in full sentences.
    description: tr('upgradeConfirmBody', {
      current: versionText(instance.version),
      latest: versionText(instance.latestVersion ?? null),
    }),
    confirmText: tr('upgradeConfirm'),
    autoFocusConfirm: true,
  });
  const upgrade = async () => {
    if (
      inFlight.current ||
      blocked.current ||
      uncertain.current ||
      upgradeCheck.state ||
      !view ||
      !canRequestUpgrade(view) ||
      !client.upgrade
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage(undefined);
    let submitted = false,
      unknown = false,
      submittedAt = 0;
    try {
      // Upgrading stops the instance for a while, like sleep, so it asks first.
      if (!(await confirm(upgradeConfirmation(view)))) return;
      if (!alive.current) return;
      submitted = true;
      setError(undefined);
      // The confirmation has closed: the row says it is scheduled at once.
      setSubmitting(true);
      setHurrying(true);
      feedRef.current?.hurry?.();
      submittedAt = Date.now();
      const operation = await client.upgrade();
      if (!alive.current) return;
      setView((before) => before && { ...before, upgradeOperation: operation });
    } catch (cause) {
      if (!alive.current) return;
      // A refusal certainly changed nothing: the toast says why (operation failures are toasts).
      const refusal = cloudRefusalKey(cause);
      if (refusal) toast.error(t(refusal));
      else if (
        cause instanceof Error &&
        ['CLOUD_SETTINGS_CONFLICT', 'CLOUD_SETTINGS_UNSUPPORTED'].includes(cause.message)
      ) {
        // The cloud would not take it: said in a toast; the dialog stays as it was (client).
        setNotStarted(true);
      } else if (
        cause instanceof Error &&
        ['CLOUD_SETTINGS_NOT_READY', 'CLOUD_SETTINGS_BUSY'].includes(cause.message)
      ) {
        // Refused before it was sent.
        setNotStarted(true);
      } else if (submitted && !(cause instanceof Error && cause.message.includes('SCOPE_CHANGED'))) {
        unknown = true;
        void upgradeCheck.start(submittedAt);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setBusy(false);
        setSubmitting(false);
        if (submitted && !unknown) await refresh();
      }
    }
  };
  // One write at a time, each on the revision the previous one returned; a change made meanwhile
  // goes out next. Only the switch changed: the calendar is sent exactly as it was.
  const writing = useRef(false),
    again = useRef(false);
  const [saving, setSaving] = useState(false);
  const policyFound = useRef<{ policy?: CloudMaintenanceView; note: 'policyChanged' | 'policyNotSaved' }>({
    note: 'policyNotSaved',
  });
  const showPolicy = (policy: CloudMaintenanceView) => {
    setView((before) => before && { ...before, maintenance: policy });
    const next = fromPolicy(policy);
    draftRef.current = next;
    setDraft(next);
    mark(false);
  };
  const confirmed = (policy: CloudMaintenanceView) => {
    feedRef.current?.onPolicySaved(policy);
    showPolicy(policy);
  };
  // What a save says once it is confirmed, as the local auto-update switch does.
  const savedToast = (current: Draft) =>
    current.autoUpdate !== current.base.autoUpdate
      ? current.autoUpdate
        ? 'autoUpdateOnToast'
        : 'autoUpdateOffToast'
      : 'scheduleSavedToast';
  const policyCheck = useSettleUnknown<{ change: CloudMaintenanceEdit; revision: string; saved: string }>({
    delays: SETTLE_DELAYS_MS.policy,
    check: async ({ change, revision }) => {
      const policy = (await readInstance()).maintenance;
      if (!policy) throw new Error('CLOUD_SETTINGS_UNAVAILABLE');
      const done = policyMatches(policy, change);
      policyFound.current = { policy, note: policy.revision !== revision ? 'policyChanged' : 'policyNotSaved' };
      return done ? 'done' : 'notDone';
    },
    onSettled: (verdict, { saved }) => {
      if (!alive.current) return;
      const { policy, note } = policyFound.current;
      if (policy) (verdict === 'done' ? confirmed : showPolicy)(policy);
      if (verdict === 'done') toast.success(tr(saved));
      if (verdict === 'notDone') setPolicyNote(note);
    },
  });
  const persist = async () => {
    if (!client.maintenance) return;
    if (writing.current) {
      again.current = true;
      return;
    }
    writing.current = true;
    setSaving(true);
    try {
      for (;;) {
        again.current = false;
        const current = draftRef.current;
        if (!current || !draftDirty(current) || !alive.current) {
          mark(false);
          return;
        }
        const parsed = cloudMaintenanceEditSchema.safeParse({
          revision: current.base.revision,
          defaultsRevision: current.base.defaultsRevision,
          autoUpdate: current.autoUpdate,
          policyMode: current.mode,
          ...(current.mode === 'custom' ? { calendar: current.calendar } : {}),
        });
        if (!parsed.success) {
          showPolicy(current.base);
          setPolicyNote('invalidCalendar');
          return;
        }
        let saved: CloudMaintenanceView;
        try {
          saved = await client.maintenance(parsed.data);
        } catch (cause) {
          if (!alive.current) return;
          const code = cause instanceof Error ? cause.message : '';
          if (code === 'CLOUD_SETTINGS_CONFLICT') {
            // Changed elsewhere: show what the instance holds now.
            try {
              const policy = (await readInstance()).maintenance;
              if (policy) showPolicy(policy);
            } catch {
              showPolicy(current.base);
            }
            setPolicyNote('policyChanged');
          } else if (
            ['CLOUD_SETTINGS_NOT_READY', 'CLOUD_SETTINGS_BUSY', 'CLOUD_SETTINGS_REJECTED',
              'CLOUD_SETTINGS_UNSUPPORTED'].includes(code)
          ) {
            // Refused before or when it arrived: nothing changed on the instance.
            showPolicy(current.base);
            setPolicyNote(code === 'CLOUD_SETTINGS_REJECTED' || code === 'CLOUD_SETTINGS_UNSUPPORTED'
              ? 'policyRejected'
              : 'policyUnavailable');
          } else
            void policyCheck.start({
              change: parsed.data,
              revision: current.base.revision,
              saved: savedToast(current),
            });
          return;
        }
        if (!alive.current) return;
        feedRef.current?.onPolicySaved(saved);
        setView((before) => before && { ...before, maintenance: saved });
        if (!again.current) {
          showPolicy(saved);
          toast.success(tr(savedToast(current)));
          return;
        }
        // A newer change waits: it goes out on the revision just returned.
        const waiting = { ...draftRef.current!, base: saved };
        draftRef.current = waiting;
        setDraft(waiting);
      }
    } finally {
      writing.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const date = (ms: number, timezone?: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(ms);
  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    text: new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, 1 + index)),
    ),
  }));
  const policy = view?.maintenance;
  const city = (zone: string) =>
    COMMON_TIMEZONES[zone] ? t(`cloudSettings.instance.timezoneCities.${COMMON_TIMEZONES[zone]}`) : null;
  // "上海，UTC+8": the offset by today's rules, so it follows daylight saving time.
  const zoneName = (zone: string) => {
    const name = city(zone);
    const offset = shortOffset(zone) || zone;
    return name && zone !== 'UTC' ? tr('zoneWithOffset', { city: name, offset }) : offset;
  };
  const describe = (calendar: CloudMaintenanceCalendar) =>
    calendar.windows
      .map((rule) => {
        const days = [...rule.weekdays].sort().join('');
        const when =
          days === '1234567'
            ? tr('scheduleEveryDay')
            : days === '12345'
              ? tr('scheduleWorkdays')
              : days === '67'
                ? tr('scheduleWeekend')
                : weekdays
                    .filter((d) => rule.weekdays.includes(d.day))
                    .map((d) => d.text)
                    .join(tr('scheduleDaySeparator'));
        return `${when} ${rule.startLocal}–${rule.endLocal}`;
      })
      .join(tr('scheduleWindowSeparator'));
  const timezone = localTimezone();
  const savedCalendar = policy && (policy.raw.calendar ?? policy.effective.calendar);
  // The default schedule is known while the instance follows it; otherwise CIS's usual one.
  const defaultCalendar = policy ? defaultCalendarOf(policy, timezone) : dailyCalendar(3, timezone);
  const repeated = policy ? defaultHour(policy, timezone) : null;
  const scheduleOptions = policy
    ? [
        ...(scheduleChoice(policy, timezone) === 'keep' && savedCalendar
          ? [
              {
                value: 'keep',
                label: tr(savedCalendar.windows.length > 1 ? 'scheduleKeepMany' : 'scheduleKeepOne'),
              },
            ]
          : []),
        { value: 'inherit', label: tr('scheduleDefault', { schedule: describe(defaultCalendar) }) },
        ...Array.from({ length: 24 }, (_, start) => start)
          .filter((start) => start !== repeated)
          .map((start) => ({
            value: `h${start}`,
            label: tr('windowDaily', { start: hour(start), end: hour(start + 2) }),
          })),
      ]
    : [];
  const scheduleHint =
    draft?.choice === 'keep' && savedCalendar
      ? tr('scheduleKept', { schedule: describe(savedCalendar), zone: zoneName(savedCalendar.timezone) })
      : draft?.choice === 'inherit' && defaultCalendar.timezone !== timezone
        ? tr('scheduleZone', {
            zone: city(defaultCalendar.timezone) ?? defaultCalendar.timezone,
            offset: shortOffset(defaultCalendar.timezone) || defaultCalendar.timezone,
          })
        : // In this computer's time zone it goes unsaid, as local schedules do (ScheduleChips).
          undefined;
  // Where the last upgrade stands; while it runs, the automatic updates wait.
  const outcome = view ? upgradeOutcome(view, !!feed?.linkOffline) : null;
  const upgrading = outcome?.kind === 'queued' || outcome?.kind === 'updating';
  const disabled =
    busy ||
    upgrading ||
    !!view?.resourceChanging ||
    (!!error && error === 'readFailed');
  // A save being read back (or that could not be read) holds the controls until it is settled.
  const policyBusy = !!policyCheck.state;
  const policyDisabled =
    disabled || policyBusy || !policy || policy.raw.scheduledTaskPolicy !== 'protect';
  // 「状态加载失败」 goes where the unreadable thing is shown: the
  // schedule's hint, or the version row's status; the refresh button is the retry.
  const scheduleUnreadable = policyCheck.state === 'unreadable';
  const notice = scheduleUnreadable ? { reload: policyCheck.reload } : unreadable;
  const status = view ? instanceStatus(view) : 'starting';
  const upgradeOffered =
    !!view?.manualUpgrade && (view.updateAvailable || !!view.upgradeOperation?.active);
  // Why "update now" cannot be used right now, under it (MyDevicesPanel's reason line).
  const upgradeReason =
    view && upgradeOffered && !canRequestUpgrade(view) && !view.upgradeOperation?.active
      ? view.loginRequired
        ? 'upgradeLoginFirst'
        : view.desiredState === 'stopped'
          ? 'upgradeWakeFirst'
          : null
      : null;
  // From the click until the end the button only spins, with no words while the result is not
  // known; the title says what is under way once CIS confirms it.
  const upgradeLoading = submitting || upgradeCheck.state === 'checking' || upgrading;
  const upgradeButton = view && (
    <Button
      variant="primary"
      size={embedded ? 'sm' : undefined}
      loading={upgradeLoading}
      disabled={
        disabled || !!upgradeCheck.state || !canRequestUpgrade(view) || !client.upgrade
      }
      onClick={() => void upgrade()}
    >
      {tr('upgradeNow')}
    </Button>
  );
  const desc = embedded ? embeddedDescription : description;
  const value = 'text-13';
  const displayVersion = (version: string) =>
    embedded ? version.replace(/(-(cn|global))?-(amd64|arm64)$/, '') : version;
  const versionText = (version: string | null) =>
    version ? displayVersion(version) : view?.imageId ? `#${view.imageId.slice(0, 12)}` : tr('unknown');
  // The version being installed. While queued, CIS still offers it as latestVersion (which can be
  // newer than the one that installs if a release lands meanwhile). Once it is installing CIS
  // offers nothing, but the instance's image is already that release, so its tag names it; only an
  // image without a tag falls back to the image id.
  const target = versionText(
    view?.latestVersion ?? (outcome?.kind === 'updating' ? view?.version ?? null : null),
  );
  // Only what adds to the title: queued behind tasks, or restarting.
  const upgradeLine =
    outcome?.kind === 'queued'
      ? tr('upgradeQueued')
      : outcome?.kind === 'updating' && outcome.offline
        ? tr('upgradeOffline')
        : null;
  // An update that failed after it started is said in the status row; one that never started is a
  // toast (failToast), as the local About page does.
  const failure = outcome?.kind === 'failed' ? outcome.reason : null;
  // Beside each 「请重试」: what the refresh button above did. While that read runs the
  // failure stays shown and its retry spins, as the device list's 「刷新」 does.
  const [rereading, setRereading] = useState<'status' | 'schedule' | null>(null);
  const statusFailed = !!unreadable || rereading === 'status';
  const scheduleFailed = scheduleUnreadable || rereading === 'schedule';
  const retryHere = (kind: 'status' | 'schedule', reload?: () => unknown) => (
    <InlineRetry
      loading={rereading === kind}
      disabled={busy}
      onRetry={() => {
        if (!reload || rereading) return;
        setRereading(kind);
        void Promise.resolve(reload()).finally(() => {
          if (alive.current) setRereading(null);
        });
      }}
    />
  );
  /**
   * The update dialog's one status row: the first row of the
   * card and the only one that changes. A state icon before the title; on the right only an action
   * (立即更新 or a retry), never a spinner. Nothing is said twice, and there is no notice above it.
   */
  // From the confirmation until CIS answers, the request is shown as scheduled.
  const requestPending = submitting || upgradeCheck.state === 'checking';
  const stateIcon = (icon: 'queued' | 'updating' | 'done' | 'failed') =>
    icon === 'queued' ? (
      <Clock3 size={14} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
    ) : icon === 'updating' ? (
      <Spinner size={14} />
    ) : icon === 'done' ? (
      <CheckCircle2 size={14} className="shrink-0 text-[var(--status-success)]" aria-hidden />
    ) : (
      <AlertCircle size={14} className="shrink-0 text-[var(--error-fg)]" aria-hidden />
    );
  const offerButton = (enabled: boolean) =>
    view && (
      <Button
        variant="primary"
        size="sm"
        disabled={!enabled || disabled || !!upgradeCheck.state || !client.upgrade}
        onClick={() => void upgrade()}
      >
        {tr('upgradeNow')}
      </Button>
    );
  const statusRow = (() => {
    if (!view) return null;
    const current = versionText(view.version);
    const latest =
      view.latestVersion && view.latestVersion !== view.version
        ? tr('newVersion', { version: displayVersion(view.latestVersion) })
        : tr('revisionAvailable');
    if (statusFailed)
      return {
        title: tr('currentVersionIs', { version: current }),
        hint: tr('statusUnreadable'),
        trailing: retryHere('status', unreadable?.reload),
      };
    if (requestPending || outcome?.kind === 'queued')
      return {
        icon: stateIcon('queued'),
        title: tr('upgradeScheduledTo', { version: target }),
        hint: tr('upgradeQueuedHint'),
      };
    // Updating, also while it restarts and DeviceLink does not have it: the same words.
    if (outcome?.kind === 'updating')
      return {
        icon: stateIcon('updating'),
        title: tr('upgradingTo', { version: target }),
        hint: tr('upgradingHint'),
      };
    if (outcome?.kind === 'done')
      return {
        icon: stateIcon('done'),
        title: tr('upgradedTo', { version: current }),
        hint: tr('upgradedHint'),
      };
    if (failure === 'rolled-back')
      return {
        icon: stateIcon('failed'),
        title: tr('upgradeFailed'),
        hint: tr('rolledBackHint', { version: current }),
        trailing: offerButton(canRequestUpgrade(view)),
      };
    if (failure === 'skipped')
      return {
        icon: stateIcon('failed'),
        title: tr('upgradeFailed'),
        hint: tr('currentShort', { version: current }),
        trailing: offerButton(canRequestUpgrade(view)),
      };
    // 语义待后端确认: recovery-hold says nothing more, and offers nothing, until its meaning is known.
    if (failure === 'held') return { icon: stateIcon('failed'), title: tr('upgradeFailed') };
    if (view.updateAvailable) {
      // No update by hand on this instance; it waits for the update hours.
      if (!view.manualUpgrade)
        return { title: latest, hint: tr('offeredScheduledOnly', { version: current }) };
      return {
        title: latest,
        // Why it cannot be updated right now.
        hint:
          upgradeReason === 'upgradeWakeFirst'
            ? tr('offeredWakeFirst', { version: current })
            : upgradeReason === 'upgradeLoginFirst'
              ? tr('offeredLoginFirst', { version: current })
              : tr('currentShort', { version: current }),
        trailing: offerButton(canRequestUpgrade(view)),
      };
    }
    return { title: tr('currentVersionIs', { version: current }), hint: tr('latestHint') };
  })();
  // The overview page (not the dialog): one line for the same states.
  const upgradeStatus =
    statusFailed || upgradeLine || outcome?.kind === 'done' || failure ? (
      <p role="status" className={`${desc} flex flex-wrap items-center gap-x-1`}>
        {statusFailed
          ? tr('statusUnreadable')
          : upgradeLine ??
          (outcome?.kind === 'done'
            ? tr('upgradedTo', { version: versionText(view?.version ?? null) })
            : tr('upgradeFailed'))}
        {statusFailed && retryHere('status', unreadable?.reload)}
      </p>
    ) : null;
  // Saving only disables the controls; what became of it is a toast (the local auto-update switch).
  const hint = scheduleFailed ? tr('statusUnreadable') : scheduleHint;
  const schedule = policy && draft && (
    // One dropdown: the default, or every day for two hours from a
    // whole hour in this computer's time zone. A custom schedule it cannot show stays as it was
    // until another choice replaces it, which asks first.
    <div className="flex flex-col gap-2">
      <p className={embedded ? embeddedLabel : label}>{tr('schedule')}</p>
      <Select
        label={tr('schedule')}
        className="w-full"
        value={draft.choice}
        disabled={policyDisabled || saving}
        options={scheduleOptions}
        onValueChange={(choice) => void choose(choice as ScheduleChoice)}
      />
      {hint && (
        <p className={`${desc} flex flex-wrap items-center gap-x-1`}>
          {hint}
          {scheduleFailed && retryHere('schedule', policyCheck.reload)}
        </p>
      )}
    </div>
  );
  const policyNotes = policy && (
    <>
      {policy.executionMode === 'preview-only' && <p className={desc}>{tr('notEnrolled')}</p>}
      {policy.raw.pausedUntilMs && policy.raw.pausedUntilMs > policy.serverTimeMs ? (
        <p className={desc}>
          {t('cloudSettings.instance.paused', {
            time: date(policy.raw.pausedUntilMs, policy.effective.calendar.timezone),
          })}
        </p>
      ) : null}
      {!embedded &&
        policy.autoUpdate &&
        policy.executionMode === 'scheduled' &&
        policy.nextEligibleAtMs && (
          <p className={desc}>
            {t('cloudSettings.instance.nextWindow', {
              time: date(policy.nextEligibleAtMs, policy.effective.calendar.timezone),
              timezone: policy.effective.calendar.timezone,
            })}
          </p>
        )}
      {policy.raw.scheduledTaskPolicy !== 'protect' && (
        <p className={desc}>{tr('unsupportedPolicy')}</p>
      )}
    </>
  );
  const autoSwitch = (title: string, detail?: string) =>
    draft &&
    policy && (
      <Row title={title} detail={detail}>
        <Switch
          aria-label={title}
          autoFocus={!!dialog}
          checked={draft.autoUpdate}
          disabled={policyDisabled || saving}
          onCheckedChange={(autoUpdate) => update({ autoUpdate })}
        />
      </Row>
    );
  const refreshButton = (
    <Button
      variant="secondary"
      tone="quiet"
      compact
      disabled={busy}
      // After a read-back ran out it reads that again; otherwise the whole instance.
      onClick={() => void (notice ? notice.reload() : reload())}
    >
      <RefreshCw size={14} />
      {tr('refresh')}
    </Button>
  );
  return (
    <Embedded.Provider value={embedded}>
      <div
        className={embedded ? 'flex flex-col gap-2' : 'flex flex-col gap-6'}
        data-testid="cloud-instance-overview"
      >
        {/* The page title, as the local settings pages carry theirs; in the dialog, only a refresh after an error. */}
        {!embedded ? (
          <SettingsPageHeader title={tr('title')} action={refreshButton} />
        ) : (
          // Only when nothing could be read: a status or schedule that could not be read has its
          // own retry beside it, so a second one here would repeat it.
          error && <div className="flex flex-wrap items-center gap-3">{refreshButton}</div>
        )}
        {error && error !== 'upgradeUnavailable' && (
          <p role="alert" className={desc}>
            {error.startsWith('cloudSettings.') ? t(error) : tr(error)}
          </p>
        )}
        {(notTaken || message) && (
          <p role="status" className={desc}>
            {tr(notTaken ? `${notTaken}NotTaken` : message!)}
          </p>
        )}
        {!view ? (
          <p className={desc} role="status">
            {t(error ? 'cloudSettings.instance.updatesUnavailable' : 'cloudSettings.loading')}
          </p>
        ) : dialog ? (
          // One settings card, as the local About page; its first row is the status row above.
          <>
            <SettingsCard>
              {statusRow && (
                <SettingsRow
                  title={
                    <span role="status" className="flex items-center gap-1.5">
                      {statusRow.icon}
                      {statusRow.title}
                    </span>
                  }
                  hint={statusRow.hint}
                  trailing={
                    statusRow.trailing && <span className="flex shrink-0 items-center">{statusRow.trailing}</span>
                  }
                />
              )}
              {!policy || !draft ? (
                <SettingsRow
                  title={tr('autoUpdate')}
                  hint={busy ? t('cloudSettings.loading') : tr('unavailable')}
                />
              ) : (
                <>
                  <SettingsRow
                    title={tr('autoUpdateEnable')}
                    hint={tr('autoDescription')}
                    trailing={
                      <Switch
                        aria-label={tr('autoUpdateEnable')}
                        autoFocus
                        checked={draft.autoUpdate}
                        disabled={policyDisabled || saving}
                        onCheckedChange={(autoUpdate) => update({ autoUpdate })}
                      />
                    }
                  />
                  {/* The dropdown does not fit a row's trailing slot: a block, as the local cards do. */}
                  <SettingsBlock>
                    <section
                      ref={maintenanceTarget}
                      id="cloud-instance-maintenance"
                      className="flex flex-col gap-2"
                    >
                      {schedule}
                      {policyNotes}
                    </section>
                  </SettingsBlock>
                </>
              )}
            </SettingsCard>
          </>
        ) : (
          <>
            <InstanceBox embedded={embedded}>
              {!embedded && (
                <Row title={view.name || name} detail={tr(`state.${status}`)}>
                  <Button
                    variant="secondary"
                    loading={powerCheck.state === 'checking'}
                    disabled={disabled || !!powerCheck.state || !stableState(view)}
                    onClick={() => void power()}
                  >
                    {view.desiredState === 'stopped' ? <Play size={14} /> : <Moon size={14} />}
                    {tr(view.desiredState === 'stopped' ? 'wake' : 'sleep')}
                  </Button>
                </Row>
              )}
              <Row title={tr('currentVersion')} detail={embedded ? undefined : tr('versionSource')}>
                <span className={`break-all ${value} text-[var(--settings-section-title)]`}>
                  {versionText(view.version)}
                </span>
              </Row>
              <Row
                title={tr('availableVersion')}
                detail={embedded && upgradeOffered ? tr('upgradeDescription') : undefined}
              >
                <span className={`break-all ${value} text-[var(--settings-section-desc)]`}>
                  {view.updateAvailable
                    ? view.latestVersion && view.latestVersion !== view.version
                      ? displayVersion(view.latestVersion)
                      : tr('revisionAvailable')
                    : tr(view.manualUpgrade || view.latestVersion ? 'noUpdate' : 'unknown')}
                </span>
                {embedded && upgradeOffered && upgradeButton}
              </Row>
              {upgradeStatus}
              {/* Without an update the available-version row already says so; no inert button. */}
              {!embedded && upgradeOffered && (
                <Row title={tr('upgradeNow')} detail={tr('upgradeDescription')}>
                  {upgradeButton}
                </Row>
              )}
            </InstanceBox>
            <section
              ref={maintenanceTarget}
              id="cloud-instance-maintenance"
              className={embedded ? 'contents' : 'flex flex-col gap-[14px]'}
            >
              {!embedded && (
                <h2 className="text-16 font-medium text-[var(--settings-section-title)]">
                  {tr('updates')}
                </h2>
              )}
              {!policy || !draft ? (
                <p className={desc}>
                  {fed && busy ? t('cloudSettings.loading') : tr('unavailable')}
                </p>
              ) : (
                <InstanceBox embedded={embedded}>
                  {autoSwitch(tr('autoUpdate'), embedded ? undefined : tr('autoDescription'))}
                  {schedule}
                  {policyNotes}
                </InstanceBox>
              )}
            </section>
          </>
        )}
      </div>
      {dialog?.footer &&
        createPortal(
          <Button variant="secondary" onClick={dialog.onCancel}>
            {tr('done')}
          </Button>,
          dialog.footer,
        )}
    </Embedded.Provider>
  );
}
