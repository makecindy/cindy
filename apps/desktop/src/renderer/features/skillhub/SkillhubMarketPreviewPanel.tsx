import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, GraduationCap, X } from 'lucide-react';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { plainTextToTiptapDoc, saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/NewMakerDraftRoute';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import type { MarketSkill } from './hooks/useMarketList';
import {
  buildPreviewTree,
  initialPreviewPath,
  previewBodyForFile,
  type HubPreviewFile,
  type HubPreviewFileMeta,
  type MarketCardPrimaryAction,
} from './lib/marketDetailViewModel';
import { marketActionErrorMessage } from './lib/marketErrors';
import { marketVisibilityLabelKey } from './lib/marketVisibility';
import { skillPublisherLabel } from './lib/publisherLabel';
import {
  effectivePublishedStatus,
  effectivePublishedStatusVersion,
  publishedStatusClass,
  publishedStatusLabelKey,
} from './lib/publishedStatus';
import { MarketPreviewTree } from './components/MarketPreviewTree';
import { ManageMenu, type MarketCardManageAction } from './components/MarketCard';
import { ScanResultDialog } from './ScanResultDialog';
import type { ScanResultPayload } from './PublishDialog';

interface SkillhubMarketPreviewPanelProps {
  skill: MarketSkill | null;
  open: boolean;
  onClose: () => void;
  /** 与卡片同口径的主操作:clone / manage / none。头部据此渲染操作按钮 */
  primaryAction?: MarketCardPrimaryAction;
  onClone?: (skill: MarketSkill) => void;
  onManageAction?: (skill: MarketSkill, action: MarketCardManageAction) => void;
}

/**
 * Market skill 详情浮层 — 市场内唯一的详情表面(交互原型 v4)。
 *
 * 结构:
 *   Hero 头部 — 标题行(标题+可见性 chip | 操作按钮),元信息行,描述(满宽)
 *   正文 — 左栏(FILES 树) + 右侧 Markdown
 * 遮罩盖整个内容区,sidebar 保持可见可点(本地安装位置只看 sidebar 的 MarketSelectionPanel)。
 */
export function SkillhubMarketPreviewPanel({
  skill,
  open,
  onClose,
  primaryAction = 'none',
  onClone,
  onManageAction,
}: SkillhubMarketPreviewPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const skillName = skill?.name ?? null;
  const skillVersion = skill?.latestVersion;
  const panelOpen = open && skillName !== null;
  const [files, setFiles] = useState<HubPreviewFileMeta[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<HubPreviewFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  // 审核状态徽标点击 → 拉取扫描结果,复用发布完成时的 ScanResultDialog
  const [scanResult, setScanResult] = useState<ScanResultPayload | null>(null);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);
  const status = skill ? effectivePublishedStatus(skill) : null;

  // ESC 关闭
  useEffect(() => {
    if (!panelOpen) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelOpen, onClose]);

  useEffect(() => {
    if (!panelOpen || !skillName) {
      setFiles([]);
      setFilesLoading(false);
      setFilesError(null);
      setSelectedPath(null);
      return undefined;
    }
    let cancelled = false;
    setFiles([]);
    setFilesLoading(true);
    setFile(null);
    setFilesError(null);
    setSelectedPath(null);
    void window.electronAPI.skillhub
      .getPublishedFiles({ name: skillName, version: skillVersion, catalogScope: skill?.catalogScope })
      .then((res) => {
        if (cancelled) return;
        setFilesLoading(false);
        if (!res.success) {
          setFilesError(marketActionErrorMessage(res.error, res.errorCode, t));
          return;
        }
        const nextFiles = res.files ?? [];
        setFiles(nextFiles);
        setSelectedPath(initialPreviewPath(nextFiles));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFilesLoading(false);
        setFilesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [panelOpen, skill?.catalogScope, skillName, skillVersion, t]);

  useEffect(() => {
    if (!panelOpen || !skillName || !selectedPath) {
      setFile(null);
      setFileLoading(false);
      return undefined;
    }
    let cancelled = false;
    // 不预清空 file:切换文件时保留旧内容直到新内容到达,避免空白帧
    setFileLoading(true);
    void window.electronAPI.skillhub
      .readPublishedFile({ name: skillName, path: selectedPath, version: skillVersion, catalogScope: skill?.catalogScope })
      .then((res) => {
        if (cancelled) return;
        setFileLoading(false);
        if (res.success && res.file) {
          setFile(res.file);
          setFilesError(null);
        } else {
          setFilesError(marketActionErrorMessage(res.error, res.errorCode, t));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFileLoading(false);
        setFilesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [panelOpen, selectedPath, skill?.catalogScope, skillName, skillVersion, t]);

  const tree = useMemo(() => buildPreviewTree(files), [files]);

  return (
    <>
      {/* 遮罩 — 盖住整个内容区(含顶部筛选工具条),sidebar 保持可用 */}
      <div
        className={cn(
          'absolute inset-0 z-30 bg-[var(--overlay-modal)] transition-opacity duration-200',
          panelOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        className={cn(
          'absolute right-3 top-3 bottom-3 z-40 flex flex-col overflow-hidden',
          'rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
          'text-[var(--msg-assistant-text)] shadow-[var(--shadow-menu)]',
          'transition-transform duration-200 ease-out',
          panelOpen ? 'translate-x-0' : 'pointer-events-none translate-x-[calc(100%+16px)]',
        )}
        style={{ width: 'min(1080px, calc(100% - 24px))', ...WINDOW_NO_DRAG_STYLE }}
        aria-hidden={!panelOpen}
        role="dialog"
        aria-label={t('skillhub.marketPreview.ariaLabel')}
      >
        {skill && (
          <div className="flex h-full min-h-0 flex-col">
            {/* Hero 头部 — 仅标题行与操作同排,元信息/描述满宽 */}
            <header className="shrink-0 border-b border-[var(--cmd-palette-border)] px-6 pb-5 pt-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <h2 className="truncate text-lg font-semibold leading-tight">
                    {skill.displayName || skill.name}
                  </h2>
                  <span
                    className="inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--chat-input-chip-bg)] text-[var(--settings-section-desc)]"
                    style={{ height: '20px', padding: '0 8px', fontSize: '11px' }}
                  >
                    {t(marketVisibilityLabelKey({
                      visibility: skill.visibility,
                      publishedVisibility: skill.publishedVisibility,
                      allowPrivateLabel: true,
                    }))}
                  </span>
                  {status ? (
                    <button
                      type="button"
                      title={t('skillhub.marketActions.viewScanResult')}
                      onClick={() => {
                        void window.electronAPI.skillhub
                          .getScanStatus({
                            slug: skill.name,
                            version: effectivePublishedStatusVersion(skill) ?? skill.latestVersion,
                            catalogScope: skill.catalogScope,
                          })
                          .then((res) => {
                            setScanResult(res.success
                              ? { status: res.status, gates: res.gates as ScanResultPayload['gates'] }
                              : { status: 'scan_status_unavailable', gates: [{ name: 'scan-status', status: 'unavailable' }] });
                            setScanDialogOpen(true);
                          });
                      }}
                      className={cn(
                        'inline-flex h-5 shrink-0 cursor-pointer items-center rounded-full border px-2 text-11 font-medium',
                        'transition-opacity hover:opacity-80',
                        publishedStatusClass(status),
                      )}
                    >
                      {t(publishedStatusLabelKey(status))}
                    </button>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {primaryAction === 'clone' ? (
                    <button
                      type="button"
                      onClick={() => {
                        // Learn = 以该 skill 为参考蒸馏本地技能(不安装原件)。
                        // 不预创建会话:把 `/learn hub:<slug> ` 预填进系统原生的
                        // New Maker 草稿,用户在那里用原生入口选 agent/模型/项目,
                        // 发送时走正常建会话路径(蒸馏会话继承该会话的模型)。
                        saveComposerDraft(NEW_MAKER_DRAFT_KEY, {
                          text: plainTextToTiptapDoc(`/learn hub:${skill.catalogScope ?? 'market'}:${skill.name} `),
                          attachments: [],
                        });
                        // 草稿目标重置为本地对话:残留的 device-link 远程草稿
                        // (workingDir/deviceId)会让 /learn 发进远程会话 —— 那里
                        // 该命令被剔除,会退化成普通消息(Codex review)。
                        // /learn 是一份新草稿,统一复位工作区、远程目标和一次性协同选择。
                        resetDraftWorkspaceTargets();
                        onClose();
                        navigate('/cc-agent/new');
                      }}
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-default)] transition-colors',
                        'text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]',
                      )}
                      style={{ height: '32px', padding: '0 14px', fontSize: '13px', fontWeight: 500 }}
                    >
                      <GraduationCap size={14} className="shrink-0" />
                      <span className="leading-none">{t('learn.hub.learnButton')}</span>
                    </button>
                  ) : null}
                  {primaryAction === 'clone' && onClone ? (
                    <button
                      type="button"
                      onClick={() => onClone(skill)}
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 rounded-full transition-colors',
                        'bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)] hover:bg-[var(--lightbox-cta-hover)]',
                      )}
                      style={{ height: '32px', padding: '0 14px', fontSize: '13px', fontWeight: 500 }}
                    >
                      <Download size={14} className="shrink-0" />
                      <span className="leading-none">{t('skillhub.marketCard.clone')}</span>
                    </button>
                  ) : null}
                  {primaryAction === 'manage' && onManageAction ? (
                    <ManageMenu skill={skill} onAction={onManageAction} />
                  ) : null}
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('diffPanel.shell.closeAria')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <p className="mt-1 truncate text-xs text-[var(--cmd-palette-item-meta)]">
                {skillPublisherLabel(skill)} · {skill.name} · v{skill.latestVersion}
              </p>
              {skill.description && (
                <p className="mt-3 text-sm leading-[1.55] text-[var(--text-secondary-mid)]">
                  {skill.description}
                </p>
              )}
            </header>

            {/* 正文:左栏(文件树) + Markdown */}
            <div className="flex min-h-0 flex-1">
              <nav className="flex w-[230px] shrink-0 flex-col border-r border-[var(--cmd-palette-border)] px-4 py-5">
                <h3 className="mb-2 shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
                  {t('skillhub.marketDetail.files')}
                </h3>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {filesLoading ? null : tree.length === 0 ? (
                    <p className="px-1 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('skillhub.marketDetail.noPreviewFiles')}
                    </p>
                  ) : (
                    <MarketPreviewTree
                      nodes={tree}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                  )}
                </div>
              </nav>

              <main
                className={cn(
                  'flex min-w-0 flex-1 flex-col overflow-y-auto bg-[hsl(var(--content-area))]',
                  'text-15 font-normal leading-[1.65] text-[var(--text-primary)]',
                )}
              >
                {/* 加载中不渲染任何中间态(空白底色保持不动),内容就绪后
                    一次成型淡入 —— 避免滑入动画期间正文连换多个状态产生闪跳 */}
                {filesLoading ? null : filesError && files.length === 0 ? (
                  <PanelState
                    icon={<FileText size={28} />}
                    title={t('skillhub.marketPreview.errorTitle')}
                    body={filesError}
                  />
                ) : tree.length === 0 ? (
                  <PanelState
                    icon={<FileText size={28} />}
                    title={t('skillhub.marketPreview.emptyTitle')}
                    body={t('skillhub.marketPreview.emptyHint')}
                  />
                ) : filesError && selectedPath ? (
                  <p className="px-10 py-8 text-sm text-[var(--cmd-palette-item-meta)]">{filesError}</p>
                ) : file ? (
                  <div key={file.path} className="w-full animate-fade-in px-10 py-8">
                    <div className="mx-auto w-full min-w-0 max-w-[860px]">
                      <MarkdownRenderer
                        workingDir=""
                        content={previewBodyForFile(file)}
                        allowPrivilegedLinks={false}
                      />
                    </div>
                  </div>
                ) : fileLoading ? null : (
                  <p className="px-10 py-8 text-sm text-[var(--cmd-palette-item-meta)]">
                    {t('skillhub.marketDetail.selectFilePrompt')}
                  </p>
                )}
              </main>
            </div>
          </div>
        )}
      </aside>

      <ScanResultDialog
        open={scanDialogOpen}
        onClose={() => setScanDialogOpen(false)}
        result={scanResult}
      />
    </>
  );
}

function PanelState({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
      <div>{icon}</div>
      <p className="text-sm">{title}</p>
      {body && <p className="max-w-sm break-words text-xs leading-[1.5]">{body}</p>}
    </div>
  );
}
