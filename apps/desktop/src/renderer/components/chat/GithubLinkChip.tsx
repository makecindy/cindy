/**
 * Inline chip for a bare GitHub URL in a chat message (group, task reply, companion).
 *
 * The chip lives inside the ordinary message link (MarkdownTargetLink), so opening, middle
 * click, the right-click menu and the PR hover popover keep their existing behaviour.
 *
 * - A PR whose status is known reads `[state icon] Title #12`. Status comes from the existing
 *   PR status cache (PrRefsContext): the task's own PR list when the link sits in a task, or
 *   an on-demand read through this computer's GitHub sign-in (60s TTL, in-flight de-duplication,
 *   main-process cache). The read starts only once the chip has been on screen.
 * - A task running on another computer never triggers a read from here (that would go through
 *   the relay on every scroll); the chip shows whatever the task's PR list already has.
 * - Everything else (issue, commit, file, repository, unknown PR state) reads as its type icon
 *   and GitHub's short reference, e.g. `owner/repo#12`, built from the URL alone.
 * - Pill geometry follows InlineReferenceChip (12px, surface-chip, 1px border); clickable, so it
 *   carries the underline signal of DESIGN.md §14.5.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookMarked,
  CircleDot,
  FileCode,
  Folder,
  GitCommitHorizontal,
  GitPullRequest,
  MessagesSquare,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { prStatusKey } from '@cindy/maker-shared';
import { externalLinkLabel, type ExternalLinkInfo } from '@cindy/maker-shared/external-link';

import { usePrActions, usePrStatuses } from '@/contexts/PrRefsContext';
import { parsePrLinkUrl } from '@/features/cc-agent/PrSummaryPopoverContent';
import { PR_STATUS_ICON, prStatusColor } from '@/features/cc-agent/gitContextPrVisuals';
import { usePrLinkContext } from './PrLinkHoverPopover';

export type GithubLinkInfo = Extract<ExternalLinkInfo, { kind: 'github' }>;

/** Anchor classes for the chip form; MarkdownTargetLink swaps these in for the plain link class. */
export const GITHUB_LINK_CHIP_CLASS = [
  'relative top-[-1px] -my-px inline-flex min-w-0 max-w-[min(480px,100%)] items-center gap-1.5 align-middle',
  'rounded-full border border-[var(--border-default)] bg-[var(--surface-chip)] px-2 py-0.5',
  'text-12 font-normal leading-[1.667] text-[var(--text-primary)]',
  'cursor-pointer underline underline-offset-2 transition-colors duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] motion-reduce:transition-none',
].join(' ');

const TYPE_ICON: Record<GithubLinkInfo['type'], LucideIcon> = {
  pull: GitPullRequest,
  issue: CircleDot,
  discussion: MessagesSquare,
  commit: GitCommitHorizontal,
  file: FileCode,
  folder: Folder,
  release: Tag,
  repo: BookMarked,
};

/** Becomes true once the element has been on screen; stays true. */
function useSeenOnScreen(enabled: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || seen || !node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, seen]);
  return { ref, seen };
}

export function GithubLinkChipBody({ link, sessionId }: { link: GithubLinkInfo; sessionId?: string }) {
  const { t } = useTranslation();
  const prRef = useMemo(() => (link.type === 'pull' ? parsePrLinkUrl(link.url) : null), [link]);
  const { cacheSessionId, deviceLinkDeviceId } = usePrLinkContext(sessionId);
  const { statuses } = usePrStatuses(cacheSessionId);
  const { ensurePrStatus } = usePrActions();
  const { ref, seen } = useSeenOnScreen(Boolean(prRef));
  const remote = Boolean(deviceLinkDeviceId);

  useEffect(() => {
    if (!prRef || !seen || remote) return;
    return ensurePrStatus(cacheSessionId, prRef);
  }, [cacheSessionId, ensurePrStatus, prRef, remote, seen]);

  const status = prRef ? statuses.get(prStatusKey(prRef)) : undefined;
  const ok = status?.ok && status.title ? status : null;
  const Icon = ok ? PR_STATUS_ICON[ok.status] : TYPE_ICON[link.type];
  const kind = t(`bots.groupChat.links.kind.${link.type}`);
  const label = externalLinkLabel(link);

  return (
    <span
      ref={ref}
      data-github-link-chip={link.type}
      data-pr-status={ok?.status}
      className="flex min-w-0 items-center gap-1.5"
    >
      <Icon
        aria-hidden
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: ok ? prStatusColor(ok.status, ok.conflicts) : 'var(--text-tertiary)' }}
      />
      {ok ? (
        <>
          <span title={`${ok.title} #${link.number}`} className="min-w-0 truncate">{ok.title}</span>
          <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">#{link.number}</span>
          <span className="sr-only">
            {`${kind} · ${link.owner}/${link.repo} · ${t(`ccAgent.gitContext.pr.status.${ok.status}`)}`}
          </span>
        </>
      ) : (
        <>
          <span className="min-w-0 truncate">{label}</span>
          <span className="sr-only">{kind}</span>
        </>
      )}
    </span>
  );
}
