/**
 * SkillhubHomeView — 技能(SkillHub)首页,/skillhub/local index。
 *
 * 重构(2026-06):SkillHub 不再用"左侧树导航 + 右侧内容"。左侧 app 侧栏还给
 * 项目/对话列表;技能整页在右侧主区,无常驻导航树,改为下钻(下一步)+ 回退:
 *   - Skill Hub 入口  → 完整 Market 浏览页(/skillhub/market)
 *   - 推荐安装的技能   → market trending 前 N,点选 → market 页(预览/安装)
 *   - 本地技能         → 已安装/本地的 skill/command/agent,点 → 详情页
 * 三块都是整页内容卡片/列表;首页是栈底,自身无返回。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  ChevronRight,
  Download,
  Package,
  SquareTerminal,
  Store,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS,
  PluginManagementLayout,
  PluginManagementPage,
} from '@/features/plugin/PluginManagementLayout';
import { canAccessSkillhubMarket } from './lib/marketAccess';
import { refresh as refreshSkillhub, useSkillhub } from './hooks/useSkillhub';
import { useMarketList, type MarketSkill } from './hooks/useMarketList';
import { basename, deriveProjectWorkingDir } from './lib/pathDerivations';
import { projectHash } from './lib/projectHash';
import { marketCardPrimaryAction } from './lib/marketDetailViewModel';
import { deriveSkillSource } from './lib/skillSource';
import {
  InstallTargetPicker,
  type InstallTargetSkill,
} from './components/InstallTargetPicker';
import { SkillhubMarketPreviewPanel } from './SkillhubMarketPreviewPanel';

const KIND_ICON: Record<string, LucideIcon> = {
  skill: Package,
  command: SquareTerminal,
  agent: Bot,
};

/** 推荐区展示条数(market trending 前 N)。 */
const RECOMMENDED_LIMIT = 8;

function includesSkillQuery(values: ReadonlyArray<string | undefined>, query: string): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLocaleLowerCase().includes(query));
}

export function SkillhubHomeView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { skills, projects, bootstrapped, syncResults } = useSkillhub();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();

  // 市场可见性门禁:仅 xd 组织的企业账号可见 Skill Hub 入口与推荐安装;
  // 其它账号(个人 / 非 xd 组织 / 未登录)只显示本地技能,且不发市场请求。
  const { user } = useAuth();
  const marketAllowed = canAccessSkillhubMarket(user);

  // 推荐 = market trending 前 N(默认排序是 updated_at,挂载时切到 trending)。
  const {
    items: marketItems,
    loading: marketLoading,
    setSortBy,
  } = useMarketList('available', { enabled: marketAllowed });
  useEffect(() => {
    setSortBy('trending');
  }, [setSortBy]);
  const recommended = useMemo(
    () =>
      marketItems
        .filter((skill) =>
          includesSkillQuery(
            [skill.displayName, skill.name, skill.description, skill.authorName],
            normalizedQuery,
          ),
        )
        .slice(0, RECOMMENDED_LIMIT),
    [marketItems, normalizedQuery],
  );

  // 本地技能:global 一组 + 每个 project 一组(displayName 取自 store.projects,兜底 basename)。
  const globalSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.scope === 'global' &&
          includesSkillQuery(
            [skill.name, skill.description, skill.kind, skill.engine],
            normalizedQuery,
          ),
      ),
    [normalizedQuery, skills],
  );
  const projectGroups = useMemo(() => {
    const byRoot = new Map<string, SkillhubSkill[]>();
    for (const s of skills) {
      if (s.scope !== 'project' || !s.projectRoot) continue;
      const arr = byRoot.get(s.projectRoot);
      if (arr) arr.push(s);
      else byRoot.set(s.projectRoot, [s]);
    }
    const nameByRoot = new Map(projects.map((p) => [p.projectRoot, p.displayName]));
    return [...byRoot.entries()]
      .map(([root, list]) => {
        const label = nameByRoot.get(root) ?? basename(root);
        return {
          root,
          label,
          skills: list.filter((skill) =>
            includesSkillQuery(
              [skill.name, skill.description, skill.kind, skill.engine, label],
              normalizedQuery,
            ),
          ),
        };
      })
      .filter((group) => group.skills.length > 0);
  }, [normalizedQuery, skills, projects]);
  const visibleLocalCount = useMemo(
    () =>
      globalSkills.length + projectGroups.reduce((count, group) => count + group.skills.length, 0),
    [globalSkills.length, projectGroups],
  );
  const hasSearchResults = (marketAllowed && recommended.length > 0) || visibleLocalCount > 0;

  // 推荐技能的预览浮层 + 安装选择器(复用 Market 那套):点推荐卡 = 下一步直接
  // 进入该技能的预览;关闭 = 回退到首页。
  const [previewSkill, setPreviewSkill] = useState<MarketSkill | null>(null);
  const [pickerSkill, setPickerSkill] = useState<MarketSkill | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 本地导入：main 选择并检查文件 → 安装位置选择器 → 凭授权导入
  const [importGrantToken, setImportGrantToken] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<InstallTargetSkill | null>(null);
  const [importPickerOpen, setImportPickerOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  const openLocal = (s: SkillhubSkill) => {
    const name = encodeURIComponent(s.name);
    const base =
      s.scope === 'global'
        ? `/skillhub/local/${s.kind}/global/${name}`
        : `/skillhub/local/${s.kind}/project/${s.projectHash}/${name}`;
    // 从首页进入 = 一次全新入口:清掉旧的技能历史栈(resetHistory),并把回退落点
    // 设为首页(from)。这样详情页「返回」回到首页这一步,而不是会话内残留的上一个技能。
    // 详情→详情的链式跳转不带 resetHistory,链路仍能逐级回退。
    navigate(`${base}?engine=${s.engine}`, {
      state: { from: '/skillhub/local', resetHistory: true },
    });
  };
  const openMarket = () => navigate('/skillhub/market');
  const openRecommended = (skill: MarketSkill) => setPreviewSkill(skill);
  const handleClone = (skill: MarketSkill) => {
    setPickerSkill(skill);
    setPickerOpen(true);
  };

  const handleImportSkill = useCallback(async () => {
    if (importBusy) return;
    setImportBusy(true);
    try {
      const picked = await window.electronAPI.skillhub.pickLocal();
      if (!picked.success) {
        toast.error(picked.message || t('skillhub.home.importFailed'));
        return;
      }
      if (picked.canceled) return;

      setImportGrantToken(picked.grantToken);
      setImportTarget({
        name: picked.name,
        versionLabel: picked.version,
        description: picked.description,
      });
      setImportPickerOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skillhub.home.importFailed'));
    } finally {
      setImportBusy(false);
    }
  }, [importBusy, t]);

  const closeImportPicker = useCallback(() => {
    setImportPickerOpen(false);
    setImportGrantToken(null);
    setImportTarget(null);
  }, []);

  return (
    <PluginManagementLayout
      activeTab="skills"
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder={t('skillhub.home.search')}
      clearSearchLabel={t('skillhub.home.clearSearch')}
    >
      <main className="relative h-full w-full overflow-x-hidden overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]">
        <PluginManagementPage className="gap-10">
          <header className="plugin-motion-page-header flex items-start justify-between gap-4">
            <div className="min-w-0 pt-1">
              <h1 className="text-28 font-medium leading-tight text-[var(--text-primary)]">
                {t('skillhub.home.title')}
              </h1>
              <p className="mt-2 max-w-2xl text-14 leading-6 text-[var(--text-secondary)]">
                {t(
                  marketAllowed
                    ? 'skillhub.home.description'
                    : 'skillhub.home.descriptionLocalOnly',
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleImportSkill()}
              disabled={importBusy}
              className={cn(
                'mt-1 inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border-default)]',
                'bg-[var(--surface-elevated)] px-3.5 text-12 font-medium text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]',
                'transition-[background-color,border-color,transform] duration-150 ease-out',
                'hover:border-[var(--text-tertiary)] hover:bg-[var(--surface-hover-soft)] active:scale-[0.98]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              aria-label={t('skillhub.home.importAria')}
            >
              <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{t('skillhub.home.import')}</span>
            </button>
          </header>

          {/* ① Skill Hub 入口 → 完整 Market 浏览页(仅市场可见账号) */}
          {marketAllowed && !normalizedQuery ? (
            <button
              type="button"
              onClick={openMarket}
              className={cn(
                'plugin-motion-page-section',
                'group flex items-center gap-4 rounded-[12px] border-[0.5px] border-[var(--border-default)]',
                'bg-[var(--surface-elevated)] px-5 py-4 text-left shadow-[var(--plugin-card-shadow)]',
                'transition-[background-color,border-color,transform] duration-150 ease-out',
                'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                'active:translate-y-0 active:scale-[0.992]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]">
                <Store size={20} className="text-[var(--msg-assistant-text)]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--msg-assistant-text)]">
                  {t('skillhub.home.browseTitle')}
                </span>
                <span className="block text-xs text-[var(--cmd-palette-item-meta)]">
                  {t('skillhub.home.browseDesc')}
                </span>
              </span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] transition-[background-color,color,transform] group-hover:translate-x-0.5 group-hover:bg-[var(--surface-chip)] group-hover:text-[var(--text-primary)] group-active:translate-x-0 group-active:scale-95">
                <ChevronRight size={16} strokeWidth={1.8} />
              </span>
            </button>
          ) : null}

          {/* ② 推荐安装(仅市场可见账号) */}
          {marketAllowed && (!normalizedQuery || recommended.length > 0 || marketLoading) ? (
            <section className="plugin-motion-page-section min-w-0">
              <SkillSectionHeading
                title={t('skillhub.home.recommended')}
                count={recommended.length}
              />
              {marketLoading && recommended.length === 0 ? (
                // 占位骨架:与真实卡片同栅格、同行数、同高度,内容到位后原地替换不跳动。
                <div className={PLUGIN_MANAGEMENT_CARD_GRID_CLASS} aria-hidden>
                  {Array.from({ length: RECOMMENDED_LIMIT }).map((_, i) => (
                    <div
                      key={i}
                      className="flex h-[100px] flex-col gap-2 rounded-[12px] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 shadow-[var(--plugin-card-shadow)]"
                    >
                      <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-60" />
                      <div className="h-3 w-full animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                      <div className="h-3 w-4/5 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                      <div className="mt-auto h-3 w-1/3 animate-pulse rounded bg-[var(--cmd-palette-item-hover)] opacity-40" />
                    </div>
                  ))}
                </div>
              ) : recommended.length === 0 ? (
                <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
                  {t('skillhub.home.recommendedEmpty')}
                </div>
              ) : (
                <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
                  {recommended.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => openRecommended(s)}
                      className={cn(
                        'group flex min-h-[100px] flex-col gap-1.5 rounded-[12px] border-[0.5px] border-[var(--border-default)]',
                        'bg-[var(--surface-elevated)] p-3 text-left shadow-[var(--plugin-card-shadow)]',
                        'transition-[background-color,border-color,transform] duration-150 ease-out',
                        'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                        'active:translate-y-0 active:scale-[0.992]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--msg-assistant-text)]">
                          {s.displayName || s.name}
                        </span>
                        {s.installedLocally && (
                          <span className="shrink-0 rounded-full bg-[var(--chat-input-chip-bg)] px-1.5 py-0.5 text-10 text-[var(--cmd-palette-item-meta)]">
                            {t('skillhub.home.installed')}
                          </span>
                        )}
                      </div>
                      {s.description && (
                        <p className="line-clamp-2 text-xs text-[var(--cmd-palette-item-meta)]">
                          {s.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 text-11 text-[var(--cmd-palette-item-meta)]">
                        <span className="min-w-0 truncate">{s.authorName}</span>
                        <span className="inline-flex shrink-0 items-center gap-0.5">
                          <Download size={11} />
                          {s.downloads}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {/* ③ 本地技能 */}
          {!normalizedQuery || visibleLocalCount > 0 ? (
            <section className="plugin-motion-page-section min-w-0">
              <SkillSectionHeading title={t('skillhub.home.local')} count={visibleLocalCount} />
              {visibleLocalCount === 0 ? (
                <div className="rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-5 text-13 leading-5 text-[var(--text-secondary)]">
                  {bootstrapped ? t('skillhub.home.localEmpty') : t('skillhub.welcome.scanning')}
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  {globalSkills.length > 0 && (
                    <LocalGroup
                      label={t('skillhub.home.globalScope')}
                      skills={globalSkills}
                      syncResults={syncResults}
                      onOpen={openLocal}
                    />
                  )}
                  {projectGroups.map((g) => (
                    <LocalGroup
                      key={g.root}
                      label={g.label}
                      skills={g.skills}
                      syncResults={syncResults}
                      onOpen={openLocal}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {normalizedQuery && !marketLoading && !hasSearchResults ? (
            <div className="plugin-motion-page-section rounded-[12px] border-[0.5px] border-[var(--border-default)] px-4 py-8 text-center text-13 leading-5 text-[var(--text-secondary)]">
              {t('skillhub.home.noSearchResults')}
            </div>
          ) : null}
        </PluginManagementPage>

        {/* 推荐技能预览浮层(下一步)+ 安装选择器 —— 复用 Market 同款。
          点推荐卡 = 打开预览;关闭 = 回退到首页。 */}
        <SkillhubMarketPreviewPanel
          open={previewSkill !== null}
          skill={previewSkill}
          onClose={() => setPreviewSkill(null)}
          primaryAction={
            previewSkill
              ? marketCardPrimaryAction({
                  isMine: previewSkill.isMine,
                  listVisibility: 'available',
                  cardState: previewSkill.cardState,
                })
              : 'none'
          }
          onClone={handleClone}
        />
        <InstallTargetPicker
          open={pickerOpen}
          skill={pickerSkill}
          onClose={() => setPickerOpen(false)}
          onInstallComplete={() => {
            void refreshSkillhub();
            setPickerOpen(false);
            // 安装后关掉预览浮层:否则它仍持有 stale previewSkill、CTA 继续显示「安装/克隆」,
            // 可被重复点安装(PR #246 review)。
            setPreviewSkill(null);
          }}
        />
        <InstallTargetPicker
          open={importPickerOpen}
          skill={importTarget}
          onClose={closeImportPicker}
          titleKey="skillhub.home.importPickerTitle"
          subtitleKey="skillhub.home.importPickerSubtitle"
          successToastKey="skillhub.home.importSuccess"
          failedToastKey="skillhub.home.importFailed"
          runAction={async ({ installPath, force }) => {
            if (!importGrantToken) {
              return { success: false, errorCode: 'INVALID_FILE', message: t('skillhub.home.importFailed') };
            }
            return window.electronAPI.skillhub.importLocal({
              grantToken: importGrantToken,
              installPath,
              force,
            });
          }}
          onInstallComplete={(result) => {
            void refreshSkillhub();
            closeImportPicker();
            if (!result?.name) return;
            const name = encodeURIComponent(result.name);
            const projectRoot = result.absolutePath
              ? deriveProjectWorkingDir(result.absolutePath)
              : null;
            if (projectRoot) {
              navigate(
                `/skillhub/local/skill/project/${projectHash(projectRoot)}/${name}`,
                { state: { from: '/skillhub/local', resetHistory: true } },
              );
              return;
            }
            navigate(`/skillhub/local/skill/global/${name}`, {
              state: { from: '/skillhub/local', resetHistory: true },
            });
          }}
        />
      </main>
    </PluginManagementLayout>
  );
}

function SkillSectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-20 font-medium leading-tight text-[var(--text-primary)]">{title}</h2>
        <span className="text-13 text-[var(--text-tertiary)]">{count}</span>
      </div>
    </div>
  );
}

function LocalGroup({
  label,
  skills,
  syncResults,
  onOpen,
}: {
  label: string;
  skills: SkillhubSkill[];
  /** server 归属结果(含 isMine),用于历史遗留 registry(origin 缺失)的来源推断 */
  syncResults: Map<string, SkillhubSyncResult>;
  onOpen: (s: SkillhubSkill) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <span className="px-1 text-13 font-medium text-[var(--text-secondary)]">{label}</span>
      <div className={cn('plugin-motion-stagger', PLUGIN_MANAGEMENT_CARD_GRID_CLASS)}>
        {skills.map((s) => {
          const Icon = KIND_ICON[s.kind] ?? Package;
          // 来源:'skillhub' = 从市场安装的副本(填充徽标);'local' = 自己开发/发布、
          // 没走 SkillHub 安装的本地副本(弱化文字,不与 SkillHub 抢视觉)。
          // origin 缺失的历史 registry 靠 server isMine 兜底判定(见 deriveSkillSource)。
          const sync = syncResults.get(s.name);
          const isMine = sync?.exists === true ? sync.isMine : null;
          const source = deriveSkillSource(
            s.registryEntry?.origin,
            s.registryEntry !== null,
            isMine,
          );
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(s)}
              className={cn(
                'group flex w-full items-start gap-3 rounded-[12px] border-[0.5px] border-[var(--border-default)] px-3 py-2.5 text-left',
                'bg-[var(--surface-elevated)] shadow-[var(--plugin-card-shadow)]',
                'transition-[background-color,border-color,transform] duration-150 ease-out',
                'hover:-translate-y-0.5 hover:border-[var(--text-tertiary)]',
                'active:translate-y-0 active:scale-[0.992]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[22%] border-[0.5px] border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--plugin-card-shadow)]">
                <Icon size={17} strokeWidth={1.75} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                    {s.name}
                  </span>
                  <span className="shrink-0 text-10 text-[var(--text-tertiary)]">
                    {source === 'skillhub'
                      ? t('skillhub.home.sourceSkillhub')
                      : t('skillhub.home.sourceLocal')}
                  </span>
                </span>
                {s.description && (
                  <span className="line-clamp-1 text-12 leading-4 text-[var(--text-secondary)]">
                    {s.description}
                  </span>
                )}
              </span>
              <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] transition-[background-color,color,transform] group-hover:translate-x-0.5 group-hover:bg-[var(--surface-chip)] group-hover:text-[var(--text-primary)] group-active:translate-x-0 group-active:scale-95">
                <ChevronRight size={15} strokeWidth={1.8} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
