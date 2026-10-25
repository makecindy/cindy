import { randomUUID } from "node:crypto";
import type {
  RemoteResourceRegistry,
  RemoteCollectionItem,
  RemoteLocalizedText,
  RemoteActionDescriptor,
} from "@cindy/device-link";
import type { TerminalTaskHost } from "../tasks/host.js";
import type { TerminalWorktrees } from "./host.js";

const labels = {
  title: ["worktree", "worktree", "worktree", "worktree", "worktree"],
  create: [
    "Create task in worktree",
    "在 worktree 中创建任务",
    "在 worktree 中建立任務",
    "worktree でタスクを作成",
    "worktree에서 작업 만들기",
  ],
  repository: ["Repository", "仓库", "儲存庫", "リポジトリ", "저장소"],
  branch: [
    "Source branch",
    "源分支",
    "來源分支",
    "ソースブランチ",
    "소스 브랜치",
  ],
  name: ["Name", "名称", "名稱", "名前", "이름"],
  open: ["Open task", "打开任务", "開啟任務", "タスクを開く", "작업 열기"],
  archive: [
    "Archive task",
    "归档任务",
    "封存任務",
    "タスクをアーカイブ",
    "작업 보관",
  ],
  restore: [
    "Restore task",
    "恢复任务",
    "還原任務",
    "タスクを復元",
    "작업 복원",
  ],
  discard: [
    "Discard unused worktree",
    "丢弃未使用的 worktree",
    "捨棄未使用的 worktree",
    "未使用の worktree を破棄",
    "사용하지 않는 worktree 삭제",
  ],
  discardTitle: [
    "Discard this unused worktree?",
    "丢弃此未使用的 worktree？",
    "捨棄此未使用的 worktree？",
    "この未使用の worktree を破棄しますか？",
    "이 사용하지 않는 worktree를 삭제할까요?",
  ],
} as const;
const text = (key: keyof typeof labels): RemoteLocalizedText => {
  const [en, cn, tw, ja, ko] = labels[key];
  return {
    fallback: en,
    translations: { en, "zh-CN": cn, "zh-TW": tw, ja, ko },
  };
};

/** The TUI and remote clients use these same owner-scoped, advertised actions. */
export function registerWorktreeResources(
  registry: RemoteResourceRegistry,
  host: TerminalWorktrees,
  tasks: TerminalTaskHost,
) {
  const items = async (): Promise<RemoteCollectionItem[]> => {
    const rows = await tasks.storage.list(),
      entries = new Map(
        host.manager
          .listAll()
          .map((meta) => [
            meta.sessionId,
            {
              id: meta.sessionId,
              path: meta.path,
              name: meta.name,
              branch: meta.branch,
            },
          ]),
      );
    for (const row of rows)
      if (row.worktreePath && !entries.has(row.id))
        entries.set(row.id, {
          id: row.id,
          path: row.worktreePath,
          name: row.title,
          branch: "",
        });
    return [...entries.values()].map((entry) => {
      const row = rows.find((row) => row.id === entry.id);
      const action: RemoteActionDescriptor = row
        ? {
            id: row.archived || row.deleted ? "restore" : "archive",
            label: text(row.archived || row.deleted ? "restore" : "archive"),
          }
        : {
            id: "discard",
            label: text("discard"),
            tone: "destructive",
            confirmation: { title: text("discardTitle") },
          };
      return {
        ref: { collectionId: "worktrees", kind: "worktree", id: entry.id },
        revision: `${row?.updatedAt ?? 0}:${entry.path}`,
        display: {
          title: row?.title || entry.name,
          subtitle: entry.branch || entry.path,
        },
        links: [],
        actions: [
          ...(row ? [{ id: "open", label: text("open") }] : []),
          action,
        ],
      };
    });
  };
  registry.register({
    collection: {
      id: "worktrees",
      resourceKind: "worktree",
      title: text("title"),
      placement: "sidebar",
      actions: [
        {
          id: "create",
          label: text("create"),
          fields: [
            {
              id: "baseRepo",
              label: text("repository"),
              kind: "text",
              required: true,
            },
            { id: "sourceBranch", label: text("branch"), kind: "text" },
            { id: "name", label: text("name"), kind: "text" },
          ],
        },
      ],
    },
    list: async (context, request) => {
      context.assertCurrent?.();
      const all = await items();
      context.assertCurrent?.();
      const rows = request.query
        ? all.filter((row) =>
            JSON.stringify(row.display)
              .toLowerCase()
              .includes(request.query!.toLowerCase()),
          )
        : all;
      const offset = request.cursor ? Number(request.cursor) : 0,
        limit = Math.min(request.limit ?? 100, 100);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error("INVALID_CURSOR");
      return {
        collectionId: "worktrees",
        revision: rows.map((row) => row.revision).join(","),
        items: rows.slice(offset, offset + limit),
        ...(offset + limit < rows.length
          ? { nextCursor: String(offset + limit) }
          : {}),
      };
    },
    get: async (context, request) => {
      context.assertCurrent?.();
      const item = (await items()).find((row) => row.ref.id === request.ref.id);
      if (!item) throw new Error("WORKTREE_NOT_FOUND");
      const path =
        host.manager.getForSession(item.ref.id)?.path ??
        (await tasks.storage.get(item.ref.id))?.worktreePath ??
        "";
      context.assertCurrent?.();
      return {
        ...item,
        blocks: [
          { id: "directory", primitive: "text", fallbackMarkdown: path },
        ],
      };
    },
    invoke: async (context, request) => {
      const current = () => context.assertCurrent?.();
      current();
      const invoke = (channel: string, args: unknown[]) =>
        tasks.invoke(channel, args, {
          source: "local",
          assertCurrent: current,
        });
      const refresh = {
        kind: "refresh-collection" as const,
        collectionId: "worktrees",
      };
      if (request.actionId === "create" && !request.resourceRef) {
        const input = request.input ?? {},
          id = randomUUID(),
          recoveryKey = randomUUID();
        const cwd = (await invoke("worktree:detect-cwd", [
          { cwd: input.baseRepo },
        ])) as { isGitRepo: boolean; currentBranch?: string };
        if (!cwd.isGitRepo) throw new Error("WORKTREE_REPOSITORY_REQUIRED");
        const created = (await invoke("worktree:create", [
          {
            sessionId: id,
            baseRepo: input.baseRepo,
            name: input.name ?? "",
            sourceBranch: input.sourceBranch || cwd.currentBranch || "HEAD",
            recoveryKey,
          },
        ])) as { ok: boolean; meta?: { path: string } };
        if (!created.ok || !created.meta)
          throw new Error("WORKTREE_CREATE_FAILED");
        try {
          await invoke("maker:create-session", [
            { id, workingDir: created.meta.path },
          ]);
        } catch (error) {
          if (!(await tasks.storage.get(id)))
            await invoke("worktree:cancel-precreated", [
              { sessionId: id, recoveryKey },
            ]);
          throw error;
        }
        return {
          result: { sessionId: id, path: created.meta.path },
          effects: [
            refresh,
            { kind: "navigate", target: { kind: "session", sessionId: id } },
          ],
        };
      }
      const ref = request.resourceRef;
      if (!ref || ref.kind !== "worktree" || ref.collectionId !== "worktrees")
        throw new Error("INVALID_ACTION");
      const item = (await items()).find((row) => row.ref.id === ref.id);
      current();
      if (!item?.actions?.some((action) => action.id === request.actionId))
        throw new Error("WORKTREE_ACTION_UNAVAILABLE");
      if (request.actionId === "open")
        return {
          effects: [
            {
              kind: "navigate",
              target: { kind: "session", sessionId: ref.id },
            },
          ],
        };
      if (request.actionId === "archive")
        await invoke("local-db:sessions:patch-meta", [
          ref.id,
          { status: "archived" },
        ]);
      else if (request.actionId === "restore") {
        const result = (await invoke("worktree:restore-for-session", [
          ref.id,
        ])) as { ok: boolean; snapshotApplied?: boolean };
        if (!result.ok || result.snapshotApplied === false)
          throw new Error("WORKTREE_RECOVERY_PENDING");
        await invoke("local-db:sessions:patch-meta", [
          ref.id,
          { status: "active" },
        ]);
      } else if (request.actionId === "discard")
        await invoke("worktree:cancel-precreated", [
          { sessionId: ref.id, path: host.manager.getForSession(ref.id)!.path },
        ]);
      else throw new Error("INVALID_ACTION");
      current();
      return { effects: [refresh] };
    },
  });
}
