import { localizeGhostRecommendation, type GhostRecommendation } from '@cindy/plugin-protocol';
import type { HomePluginRecommendationsSnapshot } from '../../../shared/homePluginRecommendations';
import {
  HOME_SUGGESTION_CATALOG,
  homeSuggestionLabelKey,
  homeSuggestionPromptKey,
  randomCategoryOrder,
  selectHomeSuggestionBatch,
  shuffled,
  type HomeSuggestionId,
} from './homeSuggestions';

export interface HomeTaskSuggestion {
  id: string;
  category: string;
  label: string;
  prompt: string;
  builtinId?: HomeSuggestionId;
  pluginId?: string;
  taskId?: string;
  needsInstall?: boolean;
  ownerId?: string | null;
}
export interface HomeTaskBatch {
  items: HomeTaskSuggestion[];
  seenIds: string[];
  displayedCount: 2 | 4;
}

/** The host owns a closed set of broad scenarios; authors cannot invent quota keys. */
export function pluginSuggestionCategory(item: GhostRecommendation): string {
  const text =
    `${item.label} ${item.locales?.en?.label ?? ''} ${item.prompt} ${item.locales?.en?.prompt ?? ''}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/email|e-mail|inbox|mail\b|邮件|郵件|メール|메일/, 'email'],
    [/photo|album|image|照片|相册|相冊|画像|写真|사진|앨범/, 'photos'],
    [/calendar|meeting|schedule|日历|日曆|会议|會議|会議|일정|캘린더/, 'calendar'],
    [/daily|every day|monitor|每天|每日|盯|監視|모니터|매일/, 'automation'],
    [
      /code|repo|pull request|bug|\bgit\b|commit|代码|代碼|项目|專案|审查.*改动|審查.*改動|未提交|コード|コミット|코드|커밋/,
      'development',
    ],
    [/document|spreadsheet|file|整理|文档|文件|文書|문서|파일/, 'documents'],
    [/game|build|create|游戏|遊戲|制作|製作|ゲーム|게임/, 'create'],
    [/computer|disk|network|电脑|電腦|网速|網速|パソコン|컴퓨터/, 'computer'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] ?? 'pluginTasks';
}

export function readPluginRecommendationSnapshot(): HomePluginRecommendationsSnapshot {
  try {
    return window.electronAPI.ghosts.recommendationsSync();
  } catch {
    return { ownerId: null, sources: [], recentIds: [], newlyInstalledId: null };
  }
}

export function buildHomeTaskCatalog(
  snapshot: HomePluginRecommendationsSnapshot,
  locale: string,
  t: (key: string) => string,
  includePlugins = true,
): HomeTaskSuggestion[] {
  const builtins: HomeTaskSuggestion[] = HOME_SUGGESTION_CATALOG.map(({ id, category }) => ({
    id,
    category,
    builtinId: id,
    label: t(homeSuggestionLabelKey(id)),
    prompt: t(homeSuggestionPromptKey(id)),
  }));
  if (!includePlugins || !snapshot.ownerId) return builtins;
  const mailItems: GhostRecommendation[] = ['today', 'unanswered', 'reply'].map((id) => ({
    id,
    label: t(`newChat.pluginSuggestions.mail.${id}.label`),
    prompt: t(`newChat.pluginSuggestions.mail.${id}.prompt`),
  }));
  const sources = [...snapshot.sources];
  if (!sources.some((s) => s.ghostId === 'google-gmail')) {
    sources.push({ ghostId: 'google-gmail', name: 'Gmail', enabled: false, items: mailItems });
  }
  for (const source of sources) {
    const installed = snapshot.sources.some((s) => s.ghostId === source.ghostId);
    // Legacy Gmail gets curated examples; an explicit empty runtime/manifest list stays empty.
    const items = source.items ?? (source.ghostId === 'google-gmail' ? mailItems : []);
    for (const raw of items) {
      const item = localizeGhostRecommendation(raw, locale);
      builtins.push({
        id: `plugin:${source.ghostId}:${item.id}`,
        category: source.ghostId === 'google-gmail' ? 'email' : pluginSuggestionCategory(raw),
        label: item.label,
        prompt: item.prompt,
        pluginId: source.ghostId,
        taskId: item.id,
        needsInstall: !installed,
        ownerId: snapshot.ownerId,
      });
    }
  }
  return builtins;
}

export function nextHomeTaskBatch(
  catalog: HomeTaskSuggestion[],
  snapshot: HomePluginRecommendationsSnapshot,
  previous: HomeTaskBatch | null,
  visibleCount: 2 | 4,
  random: () => number = Math.random,
): HomeTaskBatch {
  const previousIds = new Set(previous?.items.slice(0, previous.displayedCount).map((x) => x.id));
  const currentIds = new Set(catalog.map((x) => x.id));
  const seen = new Set(
    [...(previous?.seenIds ?? []), ...previousIds].filter((id) => currentIds.has(id)),
  );
  if (seen.size === catalog.length) seen.clear();
  const pluginGroups = new Map<string, HomeTaskSuggestion[]>();
  const candidates = catalog.filter((item) => {
    if (!item.pluginId) return true;
    const group = pluginGroups.get(item.pluginId) ?? [];
    group.push(item);
    pluginGroups.set(item.pluginId, group);
    return false;
  });
  // One candidate per source BEFORE ranking: adding tasks never multiplies a plugin's tickets.
  for (const group of pluginGroups.values()) {
    const fresh = group.filter((x) => !seen.has(x.id) && !previousIds.has(x.id));
    const alternatives = group.filter((x) => !previousIds.has(x.id));
    candidates.push(
      shuffled(fresh.length ? fresh : alternatives.length ? alternatives : group, random)[0],
    );
  }
  const available = candidates.filter((x) => !previousIds.has(x.id));
  const ranked = [
    ...randomCategoryOrder(
      available.filter((x) => !seen.has(x.id)),
      random,
    ),
    ...randomCategoryOrder(
      available.filter((x) => seen.has(x.id)),
      random,
    ),
  ];
  const pinned = candidates.find(
    (x) => x.pluginId === snapshot.newlyInstalledId && !x.needsInstall,
  );
  // Recent use is a modest hint, not a permanent slot or a raw tool-call counter.
  const recent = ranked.filter(
    (x) => x.pluginId && snapshot.recentIds.slice(0, 5).includes(x.pluginId),
  );
  if (recent.length && random() < 0.35) ranked.unshift(shuffled(recent, random)[0]);
  let items = selectHomeSuggestionBatch(pinned ? [pinned, ...ranked] : ranked, {
    fallback: randomCategoryOrder(
      candidates.filter((x) => previousIds.has(x.id)),
      random,
    ),
  });
  // Keep a general task visible even when many plugins are installed.
  if (items.length > 1 && items.every((x) => x.pluginId)) {
    const fallback = ranked.find(
      (x) => !x.pluginId && !items.some((y) => y.category === x.category),
    );
    if (fallback) items = [...items.slice(0, -1), fallback];
  }
  if (items.slice(0, 2).every((x) => x.pluginId)) {
    const generalIndex = items.findIndex((x) => x.builtinId);
    if (generalIndex > 1) [items[1], items[generalIndex]] = [items[generalIndex], items[1]];
  }
  return { items, seenIds: [...seen], displayedCount: visibleCount };
}
