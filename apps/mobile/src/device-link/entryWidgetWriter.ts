/**
 * 桌面入口组件的写入队列：把「新建任务 + 伙伴」算成一份快照交给原生。
 *
 * 之所以是队列而不是直接写：一次写入要等头像（每位伙伴一张图），等图期间名单还会变
 * （多台电脑分批返回伙伴、用户正在增删伙伴）。这些变化必须合并进同一轮并在结束后补写，
 * 否则桌面会停在旧名单上，直到下一次无关变化或重启。
 *
 * 同一个队列也负责账号边界：退登时清空快照（组件自己不读登录态，会照旧显示磁盘上的
 * 伙伴名、头像与电脑名），换账号时丢掉上一个账号的图标缓存，在途的头像结果不再写回。
 */
import type {
  EntryWidgetIcon,
  EntryWidgetTarget,
} from '../../modules/cindy-entry-widget/src';
import type { DesktopEntryIcon } from './desktopEntryIcon';
import {
  desktopEntryAvatarSignature,
  desktopEntryDestinationUrl,
  desktopEntryId,
  desktopEntryTitle,
} from './desktopEntryModel';
import { desktopEntryScheme } from './desktopEntryScheme';
import type { ResolvableCompanionIcon } from './useDesktopEntryIconResolver';
import type { DesktopEntryRow } from './useDesktopEntryRows';

/** 一次同步的最新输入。队列只在真正执行时读它，所以执行期间来的新名单不会被丢掉。 */
export interface EntryWidgetInput {
  /** 账号身份（登录代次 + 用户 ID）。切号与退登都会让它变化。 */
  accountKey: string;
  /** 已登录。false 时清空快照 —— 桌面不能留着上一个账号的资料。 */
  authenticated: boolean;
  /** 登录就绪。未就绪但已登录时什么都不做（登录页、添加账号流程）。 */
  ready: boolean;
  rows: readonly DesktopEntryRow[];
  /** 「新建任务」那一枚的标题，由调用方翻译后传入。 */
  cindyTaskTitle: string;
}

export interface EntryWidgetWriterDeps {
  /** 写原生快照，true 表示成功。 */
  write(targets: readonly EntryWidgetTarget[]): Promise<boolean>;
  /** 头像 → 图标。取不到图时由它回退成字 / 品牌图标。 */
  resolveIcon(row: ResolvableCompanionIcon): Promise<DesktopEntryIcon>;
}

export interface EntryWidgetWriter {
  /** 合并最新输入；返回的 Promise 在本轮（含合并进来的后续轮次）结束后 resolve。 */
  update(input: EntryWidgetInput): Promise<void>;
}

interface WriterState {
  /** 图标缓存：键含头像的绘制输入，值可能是 undefined（走应用图标）。 */
  icons: Map<string, EntryWidgetIcon | undefined>;
  iconsAccount: string;
  /** 已写进原生的那一版；null 表示磁盘上不该有这份快照。 */
  written: { accountKey: string; signature: string } | null;
  /** 已经确认把原生快照清空过。 */
  cleared: boolean;
}

/** 原生只认「图」和「字」两种图标；品牌图标走应用图标兜底。 */
function widgetIcon(icon: DesktopEntryIcon): EntryWidgetIcon | undefined {
  if (icon.kind === 'image' && icon.pngBase64) {
    return { kind: 'image', pngBase64: icon.pngBase64, background: icon.background };
  }
  if (icon.kind === 'glyph' && icon.text) {
    return { kind: 'glyph', text: icon.text, background: icon.background };
  }
  return undefined;
}

export function createEntryWidgetWriter(deps: EntryWidgetWriterDeps): EntryWidgetWriter {
  const state: WriterState = {
    icons: new Map(),
    iconsAccount: '',
    written: null,
    cleared: false,
  };
  /** 还没轮到的最新输入；执行期间的新输入都放这里，循环结束后补跑。 */
  let latest: EntryWidgetInput | null = null;
  let running: Promise<void> | null = null;

  /** 有更新的输入、且账号边界变了：这一轮作废，交给下一轮。 */
  const superseded = (input: EntryWidgetInput) => !!latest
    && (latest.accountKey !== input.accountKey || latest.authenticated !== input.authenticated);

  async function clear(): Promise<void> {
    if (state.cleared) return;
    state.icons = new Map();
    state.written = null;
    if (await deps.write([])) state.cleared = true;
  }

  async function sync(input: EntryWidgetInput): Promise<void> {
    if (!input.authenticated) {
      await clear();
      return;
    }
    if (!input.ready) return;
    if (state.iconsAccount !== input.accountKey) {
      // 换账号：旧头像可能来自另一个账号的媒体缓存；快照也要按新账号重写一遍。
      state.icons = new Map();
      state.iconsAccount = input.accountKey;
      state.written = null;
      state.cleared = false;
    }
    const scheme = desktopEntryScheme();
    const targets: EntryWidgetTarget[] = [{
      id: desktopEntryId({ kind: 'new-task' }),
      title: desktopEntryTitle(input.cindyTaskTitle, 'Cindy'),
      subtitle: '',
      url: desktopEntryDestinationUrl({ kind: 'new-task' }, scheme),
    }];
    const signature: string[] = [`new-task|${targets[0].title}|${scheme}`];
    for (const row of input.rows) {
      const link = {
        kind: 'companion' as const,
        deviceId: row.deviceId,
        collectionId: row.collectionId,
        companionId: row.companionId,
        sessionId: row.sessionId,
      };
      const id = desktopEntryId(link);
      // 图标签名含头像的绘制输入（图 / 回退的字 / 底色）：换了头像或回退字才重新取图，
      // 换电脑名不重新取。取图本身命中对话头像的缓存，改名不会多发请求。
      const cacheKey = `${id}:${desktopEntryAvatarSignature(row.avatar, row.title)}`;
      if (!state.icons.has(cacheKey)) {
        const icon = await deps
          .resolveIcon({ avatar: row.avatar, title: row.title, deviceId: row.deviceId, online: row.online })
          .catch((): DesktopEntryIcon => ({ kind: 'brand' }));
        // 等图期间退登 / 换号：这份图不属于当前账号，整轮作废（下一轮会重算）。
        if (superseded(input)) return;
        state.icons.set(cacheKey, widgetIcon(icon));
      }
      const title = desktopEntryTitle(row.title, '');
      const subtitle = row.deviceName ?? '';
      targets.push({
        id,
        title,
        subtitle,
        url: desktopEntryDestinationUrl(link, scheme),
        icon: state.icons.get(cacheKey),
      });
      signature.push(`${id}|${title}|${subtitle}|${cacheKey}|${scheme}`);
    }
    // 只比较轻量签名：图标 base64 很大，不参与比较。
    const next = signature.join('\n');
    if (state.written?.accountKey === input.accountKey && state.written.signature === next) return;
    if (superseded(input)) return;
    if (!(await deps.write(targets))) return;
    state.written = { accountKey: input.accountKey, signature: next };
    state.cleared = false;
  }

  async function drain(): Promise<void> {
    while (latest) {
      const input = latest;
      latest = null;
      await sync(input);
    }
  }

  const update = (input: EntryWidgetInput): Promise<void> => {
    latest = input;
    if (!running) {
      running = drain().finally(() => {
        running = null;
        // drain 判断「没有待跑了」到 running 清空之间可能又来了输入，这里补一次。
        if (latest) void update(latest);
      });
    }
    return running;
  };

  return { update };
}
