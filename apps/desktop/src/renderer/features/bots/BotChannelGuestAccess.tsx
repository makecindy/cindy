/**
 * 「访客」小节(#8359): 主人把每位私聊访客绑定到伙伴已关联的一个本机项目。
 *
 * 绑定后，这位访客的消息只在该项目里运行，并使用自己的记忆；没有绑定的访客按
 * 下方策略处理(沿用伙伴自己的工作目录，或只回一句固定提示)。只在本机设置里显示:
 * 绑定里是本机路径，不出这台电脑。
 */
import { useEffect, useRef, useState } from 'react';

import { Select } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';

import type {
  BotImConnectionListPayload,
  BotImConnectionView,
  BotImGuestAccessUpdate,
  BotImUnboundGuestPolicy,
} from '../../../shared/botImConnection';
import type { BotProjectOption } from '../../../shared/botWorkbench';
import { useBotTranslation } from './botPronounContext';
import {
  listBotImConnectionLanes,
  setBotImConnectionGuestAccess,
  type BotImConnectionApi,
} from './botImConnectionClient';

const NO_PROJECT = '__none__';

/** Display-side match only; main re-checks with the platform path rules. */
function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function projectFolderName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

interface GuestRow {
  guestId: string;
  name: string | null;
}

export function BotChannelGuestAccess({ api, view, botId, botName, onApplied }: {
  api: BotImConnectionApi | null;
  view: BotImConnectionView;
  botId: string;
  botName: string;
  onApplied: (next: BotImConnectionListPayload) => void;
}) {
  const { t } = useBotTranslation();
  const [guests, setGuests] = useState<GuestRow[] | null>(null);
  const [projects, setProjects] = useState<BotProjectOption[] | null>(null);
  const [failed, setFailed] = useState<'load' | 'save' | null>(null);
  const [saving, setSaving] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listBotImConnectionLanes(apiRef.current, view.id),
      window.electronAPI.localDb.bots.projects.list(botId),
    ])
      .then(([lanes, options]) => {
        if (cancelled) return;
        setGuests(lanes.lanes
          .filter((lane) => lane.kind === 'guest-dm' && lane.chatId)
          .map((lane) => ({ guestId: lane.chatId as string, name: lane.name })));
        setProjects(options.filter((project) => project.linked && !project.deviceId && project.available));
        setFailed(null);
      })
      .catch(() => {
        if (!cancelled) setFailed('load');
      });
    return () => {
      cancelled = true;
    };
  }, [botId, view.id]);

  const bindings = view.guestAccess?.bindings ?? {};
  const unbound: BotImUnboundGuestPolicy = view.guestAccess?.unbound ?? 'shared';
  // A bound guest whose lane was archived still needs a visible row to unbind it.
  const rows: GuestRow[] = [...(guests ?? [])];
  for (const guestId of Object.keys(bindings)) {
    if (!rows.some((row) => row.guestId === guestId)) rows.push({ guestId, name: null });
  }

  const save = (update: Omit<BotImGuestAccessUpdate, 'connectionId'>) => {
    if (saving) return;
    setSaving(true);
    setFailed(null);
    void setBotImConnectionGuestAccess(apiRef.current, { connectionId: view.id, ...update })
      .then(onApplied)
      .catch(() => setFailed('save'))
      .finally(() => setSaving(false));
  };

  if (guests === null && failed !== 'load') return null;
  const options = [
    { value: NO_PROJECT, label: t('bots.channels.guests.noProject') },
    ...(projects ?? []).map((project) => ({ value: project.path, label: project.name, title: project.path })),
  ];
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
      <div className="text-12 font-medium text-[var(--text-primary)]">{t('bots.channels.guests.title')}</div>
      <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
        {t('bots.channels.guests.hint', { name: botName })}
      </p>
      {failed !== null ? (
        <p role="alert" className="text-12 text-[var(--text-danger)]">
          {t(failed === 'load' ? 'bots.channels.guests.loadFailed' : 'bots.channels.guests.saveFailed')}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-12 text-[var(--text-primary)]">{t('bots.channels.guests.unboundLabel')}</div>
        <SegmentedControl
          aria-label={t('bots.channels.guests.unboundLabel')}
          value={unbound}
          onValueChange={(next) => save({ unbound: next })}
          height={30}
          optionHeight={24}
          optionClassName="text-11"
          options={(['shared', 'refuse'] as const).map((mode) => ({
            value: mode,
            label: t(`bots.channels.guests.unbound.${mode}`),
          }))}
        />
      </div>
      <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
        {t(`bots.channels.guests.unboundHint.${unbound}`, { name: botName })}
      </p>
      {rows.length === 0 ? (
        <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">{t('bots.channels.guests.empty')}</p>
      ) : null}
      {rows.map((row) => {
        const boundPath = Object.hasOwn(bindings, row.guestId) ? bindings[row.guestId].projectPath : null;
        const matching = boundPath === null ? undefined
          : options.find((option) => sameProjectPath(option.value, boundPath));
        const stale = boundPath !== null && !matching;
        const label = row.name || row.guestId;
        return (
          <div key={row.guestId} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-12 text-[var(--text-primary)]">{label}</div>
              <div className="truncate text-11 text-[var(--text-tertiary)]">
                {stale ? t('bots.channels.guests.projectMissing') : row.guestId}
              </div>
            </div>
            <Select
              label={t('bots.channels.guests.projectLabel', { guest: label })}
              value={matching?.value ?? boundPath ?? NO_PROJECT}
              disabled={saving}
              truncateOptions
              className="w-44 shrink-0"
              contentClassName="min-w-56"
              // Keep a stale binding selectable as the current value, so choosing
              // "No project" is a real change that removes it.
              options={stale && boundPath
                ? [...options, { value: boundPath, label: projectFolderName(boundPath), title: boundPath, disabled: true }]
                : options}
              onValueChange={(next) =>
                save({ binding: { guestId: row.guestId, projectPath: next === NO_PROJECT ? null : next } })}
            />
          </div>
        );
      })}
      {projects !== null && projects.length === 0 ? (
        <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">{t('bots.channels.guests.noProjects')}</p>
      ) : null}
    </div>
  );
}
