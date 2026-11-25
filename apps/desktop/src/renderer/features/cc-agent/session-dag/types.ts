/** Public renderer contract. The parent owns native actions and account-scoped persistence. */
export type DagNode = {
  id: string;
  parentId: string | null;
  sessionId: string;
  question: string;
  answer: string;
  userMessageId?: string;
  answerMessageId?: string;

  side?: boolean;
  runState?: 'running' | 'failed';
  toolText?: string;
};

export type DagRevision = {
  id: string;
  nodeId: string;
  question: string;
  answer: string;
  createdAt: number;
  source: 'manual';
  /** Question-only edits inherit the native answer unless based on an old edited answer. */
  nativeAnswer?: true;
};

export type ReferenceSnapshot = {
  /** Older snapshot files did not record the selected source version. */
  sourceVersion?: string;
  question: string;
  summary: string;
};

export type DagReference = {
  id: string;
  /** Already included in the branch’s first question; retain provenance without reinjecting. */
  includedInQuestion?: true;
  /** Consumer of this snapshot (the child, not the drop target). */
  fromNodeId: string;
  /** Drag origin: the source whose selected version supplied the snapshot. */
  toNodeId: string;
  snapshot: ReferenceSnapshot;
  createdAt: number;
};

export type DagAside = { id: string; nodeId: string; sessionId: string; userMessageId: string; question: string; projected?: true };

export type DagPoint = { x: number; y: number };

export type DagSize = { width: number; height: number };
export type DagSizes = Record<string, DagSize>;

export type DagCanvasState = {
  sizes?: DagSizes;
  /** Branch placeholders until history projects the native turn; legacy entries are unsent drafts. */
  pendingBranches?: PendingBranch[];
  labels?: Record<string, string>;
  /** Short display captions, separate from searchable labels and conversation history. */
  summaries?: Record<string, string>;
  /** Only accepted side questions; answers are projected from native history, never copied. */
  asides?: DagAside[];
  /** Missing keys use the native turn; selection never overwrites its content. */
  selectedVersions?: Record<string, string>;
  positions: Record<string, DagPoint>;
  revisions: DagRevision[];
  references: DagReference[];
};

export type PendingBranch = {
  id: string;
  parentId: string;
  point: DagPoint;
  question: string;
  sessionId: string;
  reference?: DagReference;
  delivery?: 'accepted';
  /** Native input anchor from the accepted send; mandatory for same-session continuations. */
  userMessageId?: string;
  reused?: true;
};

export type DagActionKind = 'retry' | 'advance' | 'aside';

export type ActionDraft = {
  forceFork?: boolean;
  /** Required for all new native sends. Keep across retries of the same explicit input. */
  branchQuestionId?: string;
  question: string;
  context: string;
};

export type AnswerVersion = {
  key: string;
  question: string;
  answer: string;

  manual: boolean;
  nativeAnswer?: true;
  createdAt?: number;
};

export type DagActionReceipt = { sessionId: string; delivery?: 'accepted'; userMessageId?: string; reused?: true };

export type DagHistoryKind = 'delete' | 'recall';
export type DagHistoryPreview = { token: string; details: string[]; requiresStop?: boolean };
/** The owning host computes the actual scope, revalidates it at commit, and restores the runtime. */
export interface DagHistoryActions {
  preview(node: DagNode, kind: DagHistoryKind): Promise<DagHistoryPreview>;
  commit(node: DagNode, kind: DagHistoryKind, token: string): Promise<{ undoId: string }>;
  undo(undoId: string): Promise<void>;
  latestUndo?: { undoId: string; label: string };
}

export type SessionDagCanvasProps = {
  historyActions?: DagHistoryActions;
  nodes: DagNode[];
  historyReady?: boolean;
  fullFamilyNodes?: DagNode[];
  storageKey: string;

  onPin?: (node: DagNode) => void;
  onOpen: (node: DagNode) => void;

  readOnly?: boolean;
  onOpenPrepared?: (sessionId: string) => void;
  onOpenChat?: () => void;
  /** Retry the original failed input, never a revision or a fork draft. */
  onRetryFailed?: (node: DagNode) => void;
  onAction: (
    node: DagNode,
    action: DagActionKind,
    draft: ActionDraft,
  ) => void | false | DagActionReceipt | Promise<void | false | DagActionReceipt>;

  /** Load before mounting; changes to storageKey mount a fresh canvas. */
  initialState?: DagCanvasState;

  /** Serialize writes per key in the host; this callback may contain private text. */
  onStateChange?: (storageKey: string, next: DagCanvasState) => void;
};

export function createEmptyState(): DagCanvasState {
  return { positions: {}, revisions: [], references: [] };
}
