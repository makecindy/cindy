/**
 * 个人机器人子页的「项目」与「模型」两行(设置 → IM 机器人 → 某平台)。
 *
 * 选了项目: 新任务放进这个侧栏项目, 模型与权限跟随它在「项目与模型」里的那一行(官方机器人、插件、
 * 个人飞书群用的同一份, 2026-11-24 用户裁决: 跟项目走)。子页只选项目, 不再放「模型」行:
 * 项目的模型只在「项目与模型」一处改(2026-11-24 用户: 内页只要能选项目)。
 * 选「对话」: 任务放在机器人自己的对话目录, 模型用这个平台自己的设置(「模型」行只在这时出现)。
 * 项目那一行没设权限时按完全访问跑, 换进这样的项目前先确认。旧 preload 没有接口时只显示平台模型。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Select } from '@/components/ui/select';
import { SettingsRow } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import type { PersonalChannelState } from '../../../shared/botImConnection';
import type { HookWorkspacePrefs } from '../../../shared/hookControlIpc';
import type { ImDefaultSettingsChannel } from '../../../shared/imDefaultSettings';
import { PLUGIN_ENGINE_DEFAULT_MODEL } from '../../../shared/pluginEngines';
import { ImBotModelRow, ImProjectModelLinkRow } from './ImBotPageParts';

type Channel = PersonalChannelState['channel'];
const DIALOGUE = '__dialogue__';

function channelApi() {
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.botImConnection;
  return api && typeof api.getPersonalChannel === 'function' && typeof api.setPersonalChannelProject === 'function'
    ? api
    : null;
}

export function usePersonalChannelProject(channel: Channel) {
  const [state, setState] = useState<PersonalChannelState | null>(null);
  const [pending, setPending] = useState(false);
  const [supported] = useState(() => channelApi() !== null);

  useEffect(() => {
    const api = channelApi();
    if (!api) return;
    let cancelled = false;
    const off = api.onPersonalChannelChanged?.((next) => {
      if (!cancelled && next.channel === channel) setState(next);
    });
    void api.getPersonalChannel!({ channel }).then((next) => { if (!cancelled) setState(next); }).catch(() => {});
    return () => { cancelled = true; off?.(); };
  }, [channel]);

  const change = useCallback(async (projectDir: string | null): Promise<boolean> => {
    const api = channelApi();
    if (!api || pending) return false;
    setPending(true);
    try {
      setState(await api.setPersonalChannelProject!({ channel, projectDir }));
      return true;
    } catch {
      return false;
    } finally {
      setPending(false);
    }
  }, [channel, pending]);

  const project = state?.projectDir ? state.projects.find((item) => item.dir === state.projectDir) ?? null : null;
  return { supported, state, project, pending, change };
}

/** 「项目」行 + 「模型」行: 选项目时显示直达「项目与模型」的摘要行，选「对话」时显示平台自己的「模型」行。 */
export function ImChannelProjectRows({ channel, appName, settingId }: {
  channel: Channel & ImDefaultSettingsChannel;
  appName: string;
  settingId?: string;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { supported, state, project, pending, change } = usePersonalChannelProject(channel);
  const [projectPref, setProjectPref] = useState<HookWorkspacePrefs | null>(null);

  useEffect(() => {
    if (!project) {
      setProjectPref(null);
      return;
    }
    const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.hookControl;
    if (!api || typeof api.getSharedProjectPrefs !== 'function') return;
    let cancelled = false;
    const load = () => {
      void api.getSharedProjectPrefs!()
        .then(({ prefs }) => {
          if (cancelled) return;
          setProjectPref(prefs.prefs.find((row) => row.workspace === project.name) ?? null);
        })
        .catch(() => {});
    };
    load();
    const off = api.onSharedProjectPrefsChanged?.((prefs) => {
      if (!cancelled) setProjectPref(prefs.prefs.find((row) => row.workspace === project.name) ?? null);
    });
    return () => { cancelled = true; off?.(); };
  }, [project]);

  if (!supported || !state) return <ImBotModelRow channel={channel} settingId={settingId} />;

  const projectModelSummary = project ? (() => {
    const model = projectPref?.model;
    if (!model) return t('settings.imBot.rows.projectModelFollow', { name: project.name });
    return model === PLUGIN_ENGINE_DEFAULT_MODEL ? t('newChat.pluginEngines.defaultModel') : model;
  })() : undefined;

  const label = t('settings.imBot.rows.project');
  const options = [
    { value: DIALOGUE, label: t('settings.imBot.rows.projectDialogue') },
    ...state.projects.map((item) => ({ value: item.dir, label: item.name })),
  ];
  if (state.projectDir && !project) {
    // 选过的项目已不在侧栏: 显示出来让人看见并改掉, 任务此时落回对话目录。
    options.push({ value: state.projectDir, label: t('settings.imBot.rows.projectMissing'), disabled: true } as typeof options[number]);
  }

  const select = async (value: string) => {
    const next = value === DIALOGUE ? null : value;
    if (next === state.projectDir) return;
    if (next) {
      const name = state.projects.find((item) => item.dir === next)?.name ?? next;
      // 选的时候现读一次那个项目的权限档(没填 = 完全访问, 同插件与官方机器人)。
      let mode: string | null = null;
      try {
        const { prefs } = await window.electronAPI.hookControl.getSharedProjectPrefs();
        mode = prefs.prefs.find((row) => row.workspace === name)?.permissionMode ?? null;
      } catch { /* 读不到按最宽的档位提示 */ }
      if (!mode || mode === 'bypassPermissions') {
        const ok = await confirm({
          title: t('settings.imBot.rows.projectFullAccessTitle', { name }),
          description: t('settings.imBot.rows.projectFullAccessDescription', { name, app: appName }),
          confirmText: t('settings.imBot.rows.projectFullAccessConfirm'),
          cancelText: t('settings.imBot.rows.projectFullAccessCancel'),
        });
        if (!ok) return;
      }
    }
    if (!(await change(next))) toast.error(t('settings.imBot.rows.projectUpdateFailed'));
  };

  return (
    <>
      <SettingsRow
        wrap
        title={label}
        hint={t(project ? 'settings.imBot.rows.projectHint' : 'settings.imBot.rows.projectDialogueHint')}
        trailing={<Select data-setting-id={settingId} label={label} value={state.projectDir ?? DIALOGUE} options={options}
          width="sm" disabled={pending} onValueChange={(value) => void select(value)} />}
      />
      {/* 选了项目时保留模型与权限直达行，一键跳进「项目与模型」；项目已移除时回到平台模型。 */}
      {project ? (
        <ImProjectModelLinkRow summary={projectModelSummary} settingId={settingId} />
      ) : (
        <ImBotModelRow channel={channel} settingId={settingId} />
      )}
    </>
  );
}
