/**
 * Live screens (`liveScreen: true`): device screens a plugin's Node worker
 * serves so the owner's phone can view and operate them over remote desktop.
 *
 * This is the one Host → worker direction outside a plugin's own main.js. It
 * reaches only enabled plugins that declare both `liveScreen` and `node`, and
 * only the fixed `liveScreen.*` methods; every request still goes through the
 * Node broker's enable, update, timeout and rate checks. Replies are plugin
 * data: each field is validated here before it reaches remote desktop.
 */
import {
  LIVE_SCREEN_BUTTON_ICONS,
  LIVE_SCREEN_BUTTON_ID,
  LIVE_SCREEN_ID,
  LIVE_SCREEN_MAX_TOUCHES,
  LIVE_SCREEN_PLATFORMS,
  type LiveScreenButton,
  type LiveScreenPlatform,
  type RemoteLiveScreen,
} from '@cindy/device-link';
import type { GhostPipeNodeResult, InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

/** Event shapes the worker receives; remote desktop maps viewer input to these. */
export type LiveScreenEvent =
  | {
      kind: 'touch';
      touches: { id: number; x: number; y: number; phase: string }[];
      edge?: string;
    }
  | { kind: 'press'; button: string }
  | { kind: 'text'; text: string }
  | { kind: 'key'; code: string; modifiers?: string[] }
  | { kind: 'release' };

export interface LiveScreenDescriptor {
  platform: LiveScreenPlatform;
  width: number;
  height: number;
  cornerRadius: number;
  maxTouches: number;
  keyboard: boolean;
  buttons: LiveScreenButton[];
}

export interface LiveScreenOpened {
  /** One-time loopback frame stream, `http://127.0.0.1:<port>/…`. */
  url: string;
  screen: LiveScreenDescriptor;
}

export interface LiveScreenHostDeps {
  plugins(): InstalledGhost[];
  request(
    instanceId: string,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<GhostPipeNodeResult>;
  locale(): 'zh-CN' | 'en';
}

export class LiveScreenError extends Error {}

const LIST_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 15_000;
const INPUT_TIMEOUT_MS = 10_000;
const MAX_SCREENS = 64;
const MAX_TASKS = 32;
const ICONS = new Set<string>(LIVE_SCREEN_BUTTON_ICONS);
const STATES = new Set(['running', 'starting', 'off']);
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
const OPEN_ERRORS = new Set(['NOT_FOUND', 'NOT_RUNNING', 'DISABLED', 'UNSUPPORTED']);

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The frame stream must stay on this computer: plain http to 127.0.0.1 with an explicit port. */
export function isLiveScreenFrameUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number.isInteger(port) &&
      port > 1023 &&
      port <= 65535 &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseLiveScreenDescriptor(value: unknown): LiveScreenDescriptor | null {
  const v = record(value);
  if (!v || !LIVE_SCREEN_PLATFORMS.includes(v.platform as LiveScreenPlatform)) return null;
  const size = (n: unknown) =>
    Number.isInteger(n) && (n as number) >= 16 && (n as number) <= 16_384;
  if (!size(v.width) || !size(v.height)) return null;
  const radius =
    typeof v.cornerRadius === 'number' && Number.isFinite(v.cornerRadius)
      ? Math.min(0.5, Math.max(0, v.cornerRadius))
      : 0;
  const touches = Number.isInteger(v.maxTouches)
    ? Math.min(LIVE_SCREEN_MAX_TOUCHES, Math.max(0, v.maxTouches as number))
    : 0;
  const buttons: LiveScreenButton[] = [];
  for (const raw of Array.isArray(v.buttons) ? v.buttons.slice(0, 16) : []) {
    const button = record(raw);
    const id =
      typeof button?.id === 'string' && LIVE_SCREEN_BUTTON_ID.test(button.id) ? button.id : null;
    const label = text(button?.label, 64);
    if (!id || !label || !ICONS.has(button!.icon as string) || buttons.some((b) => b.id === id))
      continue;
    buttons.push({ id, icon: button!.icon as LiveScreenButton['icon'], label });
  }
  return {
    platform: v.platform as LiveScreenPlatform,
    width: v.width as number,
    height: v.height as number,
    cornerRadius: radius,
    maxTouches: touches,
    keyboard: v.keyboard === true,
    buttons,
  };
}

function parseScreens(plugin: InstalledGhost, value: unknown): RemoteLiveScreen[] {
  const list = record(value)?.screens;
  if (!Array.isArray(list)) return [];
  const pluginId = installedGhostStoragePart(plugin);
  const screens: RemoteLiveScreen[] = [];
  for (const raw of list.slice(0, MAX_SCREENS)) {
    const v = record(raw);
    const id = typeof v?.id === 'string' && LIVE_SCREEN_ID.test(v.id) ? v.id : null;
    const name = text(v?.name, 128);
    if (!v || !id || !name || !LIVE_SCREEN_PLATFORMS.includes(v.platform as LiveScreenPlatform))
      continue;
    if (!STATES.has(v.state as string) || screens.some((screen) => screen.id === id)) continue;
    const taskIds = Array.isArray(v.taskIds)
      ? [
          ...new Set(
            v.taskIds.filter(
              (task): task is string => typeof task === 'string' && TASK_ID.test(task),
            ),
          ),
        ].slice(0, MAX_TASKS)
      : [];
    screens.push({
      plugin: pluginId,
      pluginName: plugin.manifest.name,
      id,
      name,
      platform: v.platform as LiveScreenPlatform,
      state: v.state as RemoteLiveScreen['state'],
      taskIds,
    });
  }
  return screens;
}

export class LiveScreenHost {
  constructor(private readonly deps: LiveScreenHostDeps) {}

  private providers(): InstalledGhost[] {
    return this.deps
      .plugins()
      .filter(
        (ghost) =>
          ghost.enabled && ghost.manifest.liveScreen === true && Boolean(ghost.manifest.node),
      );
  }

  private provider(plugin: string): InstalledGhost {
    const ghost = this.providers().find((item) => installedGhostStoragePart(item) === plugin);
    if (!ghost) throw new LiveScreenError('DESKTOP_SCREEN_UNAVAILABLE');
    return ghost;
  }

  /** A worker reply; a broker refusal, RPC error or `{ok:false}` all fail with a stable code. */
  private async call(
    plugin: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const ghost = this.provider(plugin);
    const reply = await this.deps.request(
      installedGhostStoragePart(ghost),
      method,
      { ...params, _locale: this.deps.locale() },
      timeoutMs,
    );
    if (!reply.ok)
      throw new LiveScreenError(
        reply.errorCode === 'TIMEOUT' ? 'DESKTOP_SCREEN_TIMEOUT' : 'DESKTOP_SCREEN_UNAVAILABLE',
      );
    const result = record(reply.result);
    if (!result || result.ok !== true) {
      const code =
        typeof result?.errorCode === 'string' && OPEN_ERRORS.has(result.errorCode)
          ? `DESKTOP_SCREEN_${result.errorCode}`
          : 'DESKTOP_SCREEN_FAILED';
      throw new LiveScreenError(code);
    }
    return result;
  }

  /** Every screen enabled plugins offer; a plugin that fails or is slow is left out. */
  async list(): Promise<RemoteLiveScreen[]> {
    const results = await Promise.all(
      this.providers().map(async (ghost) => {
        try {
          return parseScreens(
            ghost,
            await this.call(
              installedGhostStoragePart(ghost),
              'liveScreen.list',
              {},
              LIST_TIMEOUT_MS,
            ),
          );
        } catch {
          return [];
        }
      }),
    );
    return results.flat().slice(0, MAX_SCREENS);
  }

  async open(plugin: string, id: string): Promise<LiveScreenOpened> {
    const result = await this.call(plugin, 'liveScreen.open', { id }, OPEN_TIMEOUT_MS);
    const screen = parseLiveScreenDescriptor(result.screen);
    if (!isLiveScreenFrameUrl(result.url) || !screen)
      throw new LiveScreenError('DESKTOP_SCREEN_FAILED');
    return { url: result.url, screen };
  }

  async input(plugin: string, id: string, events: LiveScreenEvent[]): Promise<void> {
    await this.call(plugin, 'liveScreen.input', { id, events }, INPUT_TIMEOUT_MS);
  }

  async control(
    plugin: string,
    id: string,
    options: { fps?: number; keyframe?: boolean },
  ): Promise<void> {
    await this.call(plugin, 'liveScreen.control', { id, ...options }, INPUT_TIMEOUT_MS);
  }

  async close(plugin: string, id: string): Promise<void> {
    await this.call(plugin, 'liveScreen.close', { id }, INPUT_TIMEOUT_MS);
  }
}
