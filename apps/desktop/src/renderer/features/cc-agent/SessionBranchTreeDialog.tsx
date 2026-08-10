import * as Dialog from '@radix-ui/react-dialog';
import { Bot, ChevronRight, GitBranch, MessageSquare, Pi, Sparkles, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { SessionTreeNode, SessionTreeSnapshot } from '@cindy/maker-core';

import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { makerApiFor } from '@/lib/makerTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { Spinner } from '@/components/ui/spinner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  sessions: Session[];
  running: boolean;
  writeBlocked: boolean;
}

function sessionFamily(current: Session, sessions: Session[]): Session[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  byId.set(current.id, current);
  let root = current;
  const seen = new Set([current.id]);
  while (root.parentSessionId && byId.has(root.parentSessionId) && !seen.has(root.parentSessionId)) {
    root = byId.get(root.parentSessionId)!;
    seen.add(root.id);
  }
  const family: Session[] = [];
  const visit = (session: Session, path: Set<string>): void => {
    if (path.has(session.id)) return;
    family.push(session);
    const nextPath = new Set(path).add(session.id);
    for (const child of byId.values()) {
      if (child.parentSessionId === session.id) visit(child, nextPath);
    }
  };
  visit(root, new Set());
  return family;
}

function roleIcon(node: SessionTreeNode) {
  if (node.role === 'user') return <UserRound size={13} />;
  if (node.role === 'assistant') return <Bot size={13} />;
  if (node.role === 'summary') return <Sparkles size={13} />;
  return <MessageSquare size={13} />;
}

export function SessionBranchTreeDialog({
  open,
  onOpenChange,
  session,
  sessions,
  running,
  writeBlocked,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tree, setTree] = useState<SessionTreeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [summarize, setSummarize] = useState(false);
  const [summaryFocus, setSummaryFocus] = useState('');
  const family = useMemo(() => sessionFamily(session, sessions), [session, sessions]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Session[]>();
    const ids = new Set(family.map((item) => item.id));
    for (const item of family) {
      const parent = item.parentSessionId && ids.has(item.parentSessionId) ? item.parentSessionId : null;
      map.set(parent, [...(map.get(parent) ?? []), item]);
    }
    return map;
  }, [family]);

  const loadTree = useCallback(async () => {
    if (session.agentKind !== 'pi') {
      setTree(null);
      return;
    }
    setLoading(true);
    try {
      setTree(await makerApiFor(session.id).getSessionTree(session.id));
    } catch {
      setTree(null);
      toast.warning(t('ccAgent.sidebar.sessionBranches.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [session.agentKind, session.id, t]);

  useEffect(() => {
    if (!open) return;
    void loadTree();
  }, [loadTree, open]);

  const switchBranch = useCallback(async (node: SessionTreeNode) => {
    if (switchingId || running || writeBlocked || node.id === tree?.leafId) return;
    setSwitchingId(node.id);
    try {
      const result = await makerApiFor(session.id).navigateSessionTree(session.id, node.id, {
        summarize,
        ...(summarize && summaryFocus.trim() ? { customInstructions: summaryFocus.trim() } : {}),
      });
      if (!result || result.cancelled) return;
      setTree(result.tree);
      makerChatStore.reloadMessages(session.id);
      if (result.draftText) {
        saveDraft(session.id, {
          text: plainTextToTiptapDoc(result.draftText),
          attachments: [],
          focusAtEnd: true,
        });
      }
      toast.success(
        t(result.draftText
          ? 'ccAgent.sidebar.sessionBranches.switchedWithDraft'
          : 'ccAgent.sidebar.sessionBranches.switched'),
      );
      onOpenChange(false);
    } catch (error) {
      toast.warning(
        running
          ? t('ccAgent.sidebar.sessionBranches.runningBlocked')
          : writeBlocked
            ? t('ccAgent.sidebar.sessionBranches.remoteBlocked')
          : t('ccAgent.sidebar.sessionBranches.switchFailed'),
      );
    } finally {
      setSwitchingId(null);
    }
  }, [onOpenChange, running, session.id, summarize, summaryFocus, switchingId, t, tree?.leafId, writeBlocked]);

  const openSession = useCallback(async (target: Session) => {
    if (target.id === session.id) return;
    const route = await resolveSessionRoute(target.id, target);
    onOpenChange(false);
    navigate(route);
  }, [navigate, onOpenChange, session.id]);

  const renderPiNode = (node: SessionTreeNode, depth: number): React.ReactNode => {
    const active = tree?.activePathIds.includes(node.id) === true;
    const leaf = tree?.leafId === node.id;
    const branching = node.children.length > 1;
    return (
      <div key={node.id}>
        <button
          type="button"
          disabled={running || writeBlocked || switchingId !== null || leaf}
          onClick={() => void switchBranch(node)}
          className={cn(
            'group flex min-h-8 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
            'hover:bg-[var(--surface-elevated)] disabled:cursor-default',
            active && 'bg-[var(--surface-elevated)]',
          )}
          style={{ paddingLeft: `${10 + depth * 18}px` }}
        >
          <span
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
              active
                ? 'border-[var(--accent-cta-bg-pure)] text-[var(--accent-cta-bg-pure)]'
                : 'border-[var(--border-default)] text-[var(--text-tertiary)]',
            )}
          >
            {switchingId === node.id ? <Spinner size={12} /> : roleIcon(node)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-11 text-[var(--text-tertiary)]">
              {node.label || t(`ccAgent.sidebar.sessionBranches.role.${node.role ?? 'system'}`)}
              {branching && <GitBranch size={11} />}
              {leaf && <span>{t('ccAgent.sidebar.sessionBranches.current')}</span>}
            </span>
            <span className="line-clamp-2 text-12 leading-4 text-[var(--text-primary)]">
              {node.preview || t('ccAgent.sidebar.sessionBranches.emptyEntry')}
            </span>
          </span>
        </button>
        {node.children.map((child) => renderPiNode(child, depth + 1))}
      </div>
    );
  };

  const renderSession = (item: Session, depth: number): React.ReactNode => {
    const current = item.id === session.id;
    return (
      <div key={item.id}>
        <button
          type="button"
          onClick={() => void openSession(item)}
          className={cn(
            'flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--surface-elevated)]',
            current && 'bg-[var(--surface-elevated)]',
          )}
          style={{ paddingLeft: `${10 + depth * 18}px` }}
        >
          {item.agentKind === 'pi' ? <Pi size={15} /> : <GitBranch size={15} />}
          <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]">
            {item.title?.trim() || t('ccAgent.sessionHeader.untitled')}
          </span>
          {current && <span className="text-11 text-[var(--text-tertiary)]">{t('ccAgent.sidebar.sessionBranches.current')}</span>}
          {!current && <ChevronRight size={13} className="text-[var(--text-tertiary)]" />}
        </button>
        {current && session.agentKind === 'pi' && (
          <div className="ml-4 border-l border-[var(--border-default)] pl-1">
            {loading ? (
              <div className="flex h-16 items-center justify-center"><Spinner size={16} /></div>
            ) : tree && tree.roots.length > 0 ? (
              tree.roots.map((root) => renderPiNode(root, depth + 1))
            ) : (
              <div className="px-3 py-3 text-12 text-[var(--text-tertiary)]">
                {t('ccAgent.sidebar.sessionBranches.empty')}
              </div>
            )}
          </div>
        )}
        {(childrenByParent.get(item.id) ?? []).map((child) => renderSession(child, depth + 1))}
      </div>
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !switchingId && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[min(760px,calc(100vh-48px))] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border shadow-[var(--confirm-shadow)]"
          style={{ backgroundColor: 'var(--confirm-bg)', borderColor: 'var(--border-default)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-start gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-default)' }}>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">
                {t('ccAgent.sidebar.sessionBranches.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">
                {t('ccAgent.sidebar.sessionBranches.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-elevated)]" aria-label={t('ccAgent.sidebar.sessionBranches.close')}>
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {(childrenByParent.get(null) ?? []).map((root) => renderSession(root, 0))}
          </div>

          {session.agentKind === 'pi' && (
            <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-default)', backgroundColor: 'var(--surface-subtle)' }}>
              <label className="flex items-center gap-2 text-12 text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={summarize}
                  onChange={(event) => setSummarize(event.target.checked)}
                  disabled={switchingId !== null}
                  className="accent-[var(--accent-cta-bg-pure)]"
                />
                {t('ccAgent.sidebar.sessionBranches.summarize')}
              </label>
              {summarize && (
                <input
                  value={summaryFocus}
                  onChange={(event) => setSummaryFocus(event.target.value.slice(0, 4000))}
                  placeholder={t('ccAgent.sidebar.sessionBranches.summaryFocus')}
                  className="mt-2 h-8 w-full rounded-lg border bg-[var(--settings-input-bg)] px-2 text-12 text-[var(--settings-input-text)] outline-none"
                  style={{ borderColor: 'var(--settings-input-border)' }}
                />
              )}
              <p className="mt-2 text-11 leading-4 text-[var(--text-tertiary)]">
                {running
                  ? t('ccAgent.sidebar.sessionBranches.runningBlocked')
                  : writeBlocked
                    ? t('ccAgent.sidebar.sessionBranches.remoteBlocked')
                  : t('ccAgent.sidebar.sessionBranches.filesWarning')}
              </p>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
