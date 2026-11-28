/**
 * 设置 → IM 机器人 → 某平台 的「项目」与「谁来回复」(个人机器人)。
 *
 *   - imPersonalChannel:get           这个平台此刻的选择 + 可选的侧栏项目;
 *   - imPersonalChannel:set-project   只能选侧栏里的本机项目(或 null = 对话目录);
 *   - imPersonalChannel:set-companion 交给哪位伙伴(null = Cindy)。个人微信沿用 wechatBot:set-companion。
 * 改动广播 imPersonalChannel:changed, 设置页与主页列表据此刷新。
 */

import { BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';

import type { PersonalChannelState } from '../../../shared/botImConnection';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import { getDbClient } from '../../localDb/client/current';
import { botProfiles } from '../../localDb/schema';
import { createLogger } from '../../logger';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { switchPersonalBotReplyTarget } from './botImPersonalAdoption';
import { listProjectsForControl } from './controlProjects';
import { imProjectAliasForDir, syncImProjectWorkspaces } from './imProjectPorts';
import {
  clearPersonalChannelChoice,
  isPersonalChannel,
  listPersonalChannelsForCompanion,
  readPersonalChannelChoice,
  writePersonalChannelChoice,
  type PersonalChannel,
} from './personalChannelStore';

const log = createLogger('im/personal-channel-ipc');
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
let registered = false;

async function listProjects(): Promise<PersonalChannelState['projects']> {
  await syncImProjectWorkspaces();
  const projects = await listProjectsForControl({ projectsOnly: true, all: true });
  return projects.map((project) => ({
    dir: project.workingDir,
    // 与「项目与模型」同一个名字(跟随侧栏); 名表还没建起来时用目录名。
    name: imProjectAliasForDir(project.workingDir) ?? project.displayName,
  }));
}

async function stateOf(channel: PersonalChannel): Promise<PersonalChannelState> {
  const choice = readPersonalChannelChoice(channel);
  return { channel, projectDir: choice.projectDir, companionBotId: choice.companionBotId, projects: await listProjects() };
}

async function broadcast(channel: PersonalChannel): Promise<PersonalChannelState> {
  const state = await stateOf(channel);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('imPersonalChannel:changed', state);
  }
  return state;
}

function channelOf(payload: unknown): PersonalChannel {
  const channel = (payload as { channel?: unknown } | null)?.channel;
  if (!isPersonalChannel(channel)) throwIpcError('INVALID_PARAMS', 'channel is invalid');
  return channel;
}

async function setProject(channel: PersonalChannel, projectDir: unknown): Promise<PersonalChannelState> {
  if (projectDir !== null && typeof projectDir !== 'string') throwIpcError('INVALID_PARAMS', 'projectDir is invalid');
  if (typeof projectDir === 'string') {
    // 只认侧栏里的本机项目: 这份选择同时是「IM 能驱动哪个目录」的授权。
    const normalized = normalizeWorkingDirForStorage(projectDir);
    const projects = await listProjectsForControl({ projectsOnly: true, all: true });
    if (!normalized || !projects.some((p) => normalizeWorkingDirForStorage(p.workingDir) === normalized)) {
      throwIpcError('NOT_FOUND', 'PROJECT_NOT_FOUND');
    }
  }
  writePersonalChannelChoice(channel, { projectDir: projectDir as string | null });
  return broadcast(channel);
}

async function setCompanion(channel: PersonalChannel, botId: unknown): Promise<PersonalChannelState> {
  if (channel === 'wechat') throwIpcError('INVALID_PARAMS', 'wechat uses wechatBot:set-companion');
  if (botId !== null && (typeof botId !== 'string' || !BOT_ID_RE.test(botId))) {
    throwIpcError('INVALID_PARAMS', 'companionBotId is invalid');
  }
  await withBotProfileLocks(botId ? [botId as string] : [], async () => {
    if (botId) {
      const [row] = await getDbClient().drizzle.select({ status: botProfiles.status })
        .from(botProfiles).where(eq(botProfiles.id, botId as string)).limit(1);
      if (row?.status !== 'active') throwIpcError('NOT_FOUND', 'BOT_INACTIVE');
    }
    await switchPersonalBotReplyTarget(channel, () => {
      writePersonalChannelChoice(channel, { companionBotId: botId as string | null });
    });
  });
  log.info(`personal ${channel} bot now replies as ${botId ? 'teammate' : 'Cindy'}`);
  return broadcast(channel);
}

/** 仅广播某个个人渠道状态变化(例如移交伙伴后外部已清盘)。 */
export async function broadcastPersonalChannelState(channel: PersonalChannel): Promise<void> {
  try {
    await broadcast(channel);
  } catch (err) {
    log.warn(`broadcast personal channel state for ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 解绑或移交个人机器人后清空该平台的项目与伙伴归属，并广播刷新设置页。 */
export async function clearPersonalChannelState(channel: PersonalChannel): Promise<void> {
  try {
    if (!clearPersonalChannelChoice(channel)) return;
    await broadcast(channel);
  } catch (err) {
    log.warn(`clear personal channel state for ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 伙伴被删除时，把设置页里交给这位伙伴的个人机器人安全切回普通任务并刷新界面。 */
export async function clearPersonalChannelsForCompanion(botId: string): Promise<void> {
  const channels = listPersonalChannelsForCompanion(botId);
  for (const channel of channels) {
    try {
      const clear = () => {
        if (readPersonalChannelChoice(channel).companionBotId === botId) {
          writePersonalChannelChoice(channel, { companionBotId: null });
        }
      };
      try {
        await switchPersonalBotReplyTarget(channel, clear, { allowWhileBusy: true });
      } catch {
        // 传输层尚未启动或正在切换时直接落盘，不阻塞伙伴删除。
        clear();
      }
      await broadcast(channel);
    } catch (err) {
      log.warn(`clear personal ${channel} companion on delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function registerPersonalChannelIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('imPersonalChannel:get', (event, payload) => {
    assertTrustedAppRendererEvent(event);
    return stateOf(channelOf(payload));
  });
  ipcMain.handle('imPersonalChannel:set-project', (event, payload) => {
    assertTrustedAppRendererEvent(event);
    return setProject(channelOf(payload), (payload as { projectDir?: unknown }).projectDir ?? null);
  });
  ipcMain.handle('imPersonalChannel:set-companion', (event, payload) => {
    assertTrustedAppRendererEvent(event);
    return setCompanion(channelOf(payload), (payload as { companionBotId?: unknown }).companionBotId ?? null);
  });
}
