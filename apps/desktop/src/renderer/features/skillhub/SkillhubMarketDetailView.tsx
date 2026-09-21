import { SkillDetailPage, SkillDetailHeader, SkillDetailColumns, SkillDetailSidebar, SkillDetailContent, SkillDetailResizeHandle } from './components/SkillDetailLayout';
import { useMetaColumnResize } from './hooks/useMetaColumnResize';
import { MarketInstallStatus } from './components/MarketInstallStatus';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, GraduationCap } from 'lucide-react';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
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
import { MarketLocalSkills } from './components/MarketLocalSkills';
import { ManageMenu, type MarketCardManageAction } from './components/MarketCard';
import { ScanResultDialog } from './ScanResultDialog';
import type { ScanResultPayload } from './PublishDialog';

interface SkillhubMarketDetailViewProps {
  skill: MarketSkill | null;
  open?: boolean;
  navigation?: ReactNode;
  localActions?: ReactNode;
  onUpdate?: (skill: MarketSkill) => void;
  updating?: boolean;
  onClose: () => void;
  /** 与卡片同口径的主操作:clone / manage / none。头部据此渲染操作按钮 */
  primaryAction?: MarketCardPrimaryAction;
  onClone?: (skill: MarketSkill) => void;
  onManageAction?: (skill: MarketSkill, action: MarketCardManageAction) => void;
  learnSkillEnabled?: boolean;
}

/**
 * Market content controller for the shared Skill detail page.
 *
 * 结构:
 *   Hero 头部 — 标题行(标题+可见性 chip | 操作按钮),元信息行,描述(满宽)
 *   正文 — 左栏(FILES 树) + 右侧 Markdown
 * Local operations are bound to the copy selected by the route.
 */
export function SkillhubMarketDetailView({
  skill,
  open = true,
  navigation, localActions, onUpdate, updating,
  onClose,
  primaryAction = 'none',
  onClone,
  onManageAction,
  learnSkillEnabled = true,
}: SkillhubMarketDetailViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const metaResize = useMetaColumnResize();
  const { dataOwnerId } = useAuth();
  const owner = getDataOwnerGeneration();
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
  const [scanResultOwner, setScanResultOwner] = useState<DataOwnerGeneration | null>(null);
  const status = skill ? effectivePublishedStatus(skill) : null;
  const reviewVersion = skill ? effectivePublishedStatusVersion(skill) ?? skill.latestVersion : undefined;
  const scanRequestId = useRef(0);

  useEffect(() => {
    setScanDialogOpen(false);
    setScanResult(null);
    setScanResultOwner(null);
    // A late reply must not show another Skill/version's private review feedback.
    return () => { scanRequestId.current += 1; };
  }, [panelOpen, skillName, reviewVersion, status, skill?.catalogScope, skill?.canManage, dataOwnerId, owner]);

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
  const currentScanResult = scanResultOwner && isDataOwnerGenerationCurrent(scanResultOwner) ? scanResult : null;

  if (!panelOpen || !skill) return null;
  return (
    <SkillDetailPage>
      <SkillDetailHeader
        title={skill.displayName || skill.name}
        backLabel={t('skillhub.detail.backToSkillhub')}
        onBack={onClose}
        badges={<>
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
                        if (!isDataOwnerGenerationCurrent(owner)) return;
                        const requestId = ++scanRequestId.current;
                        const isCurrentRequest = () => requestId === scanRequestId.current && isDataOwnerGenerationCurrent(owner);
                        void window.electronAPI.skillhub
                          .getScanStatus({
                            slug: skill.name,
                            version: reviewVersion,
                            // Catalog reads only expose approved releases; owners read failed/rejected releases natively.
                            catalogScope: status === 'rejected' && skill.canManage ? undefined : skill.catalogScope,
                          })
                          .then((res) => {
                            if (!isCurrentRequest()) return;
                            setScanResultOwner(owner);
                            setScanResult(res.success
                              ? { status: res.status, gates: res.gates as ScanResultPayload['gates'], rejectionReason: res.rejectionReason }
                              : { status: 'scan_status_unavailable', gates: [{ name: 'scan-status', status: 'unavailable' }] });
                            setScanDialogOpen(true);
                          })
                          .catch(() => {
                            if (!isCurrentRequest()) return;
                            setScanResultOwner(owner);
                            setScanResult({ status: 'scan_status_unavailable', gates: [{ name: 'scan-status', status: 'unavailable' }] });
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
        </>}
        subtitle={<p className="truncate text-xs text-[var(--cmd-palette-item-meta)]">{skillPublisherLabel(skill)} · {skill.name} · v{skill.latestVersion}</p>}
        actions={<>
          <MarketInstallStatus skill={skill} onUpdate={onUpdate} updating={updating} />
                  {primaryAction === 'clone' ? (
                    <Button
                      variant="secondary"
                      disabled={!learnSkillEnabled}
                      title={learnSkillEnabled ? undefined : t('learn.hub.disabledHint')}
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
                      className="gap-1.5 px-3.5"
                    >
                      <GraduationCap size={14} className="shrink-0" />
                      <span className="leading-none">{t('learn.hub.learnButton')}</span>
                    </Button>
                  ) : null}
                  {primaryAction === 'clone' && onClone && !skill.updateAvailable && !updating ? (
                    <Button
                      variant="cta"
                      onClick={() => onClone(skill)}
                      className="gap-1.5 px-3.5"
                    >
                      <Download size={14} className="shrink-0" />
                      <span className="leading-none">{t('skillhub.marketCard.clone')}</span>
                    </Button>
                  ) : null}
                  {primaryAction === 'manage' && onManageAction ? (
                    <ManageMenu skill={skill} onAction={onManageAction} />
                  ) : null}
                  {localActions !== undefined ? localActions : <MarketLocalSkills key={`${skill.catalogScope}:${skill.name}`} skill={skill} />}
        </>}
      />
      {navigation}
      <SkillDetailColumns resizing={metaResize.isDragging}>
        <SkillDetailSidebar width={metaResize.width}>
                <h3 className="mb-2 shrink-0 text-xs font-medium uppercase tracking-wider text-[var(--cmd-palette-item-meta)]">
                  {t('skillhub.marketDetail.files')}
                </h3>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
          <SkillDetailResizeHandle resize={metaResize} />
        </SkillDetailSidebar>
        <SkillDetailContent>
          {skill.description && <p className="mb-6 text-sm text-[var(--text-secondary)]">{skill.description}</p>}
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
                  <div key={file.path} className="w-full animate-fade-in">
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
        </SkillDetailContent>
      </SkillDetailColumns>
      <ScanResultDialog
        open={scanDialogOpen && currentScanResult !== null}
        onClose={() => { scanRequestId.current += 1; setScanDialogOpen(false); }}
        result={currentScanResult}
      />
    </SkillDetailPage>
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
