import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  RemoteResourceRegistry,
  RemoteText,
  RemoteCollectionItem,
} from "@cindy/device-link";
import type { Logger } from "@cindy/maker-core";
import type { DataOwnerPushStamp } from "@cindy/maker-shared/dataOwnerPush";
import { projectKeyComparisonKey } from "@cindy/maker-shared/project-keys";
import {
  createProjectRegistration,
  type LocalProjectContext,
} from "@cindy/app-runtime/projectRegistration";
import { createProjectManagement } from "@cindy/app-runtime/projectManagement";
import { createProjectMove } from "@cindy/app-runtime/moveSession";
import { createProjectAliases } from "@cindy/app-runtime/projectAliases";
import {
  createSidebarSettingsDocument,
  MAX_HIDDEN_PROJECT_ENTRIES,
} from "@cindy/app-runtime/sidebarSettingsDocument";
import { assertTaskActionCurrent } from "@cindy/app-runtime/taskActionAuthorization";
import type { TerminalTaskHost } from "./tasks/host.js";

const copy = {
  projects: ["Projects", "项目", "專案", "プロジェクト", "프로젝트"],
  add: [
    "Add folder",
    "添加文件夹",
    "加入資料夾",
    "フォルダーを追加",
    "폴더 추가",
  ],
  name: ["Name", "名称", "名稱", "名前", "이름"],
  folder: ["Folder", "文件夹", "資料夾", "フォルダー", "폴더"],
  open: [
    "New session here",
    "在此新建任务",
    "在此新增任務",
    "ここでセッションを作成",
    "여기서 세션 만들기",
  ],
  edit: ["Rename", "重命名", "重新命名", "名前を変更", "이름 바꾸기"],
  remove: [
    "Remove from projects",
    "移出项目列表",
    "從專案清單移除",
    "プロジェクト一覧から削除",
    "프로젝트 목록에서 제거",
  ],
} as const;
const t = (key: keyof typeof copy): RemoteText => {
  const [fallback, cn, tw, ja, ko] = copy[key];
  return { fallback, translations: { "zh-CN": cn, "zh-TW": tw, ja, ko } };
};

type Project = Awaited<
  ReturnType<
    ReturnType<typeof createProjectManagement>["listRegisteredProjects"]
  >
>["projects"][number];
const identity = (directory: string) =>
  projectKeyComparisonKey(`local:${directory}`, process.platform) ?? directory;
const id = (directory: string) =>
  createHash("sha256").update(identity(directory)).digest("hex");

/** Same recent-workdir records, aliases and sidebar preferences as GUI and
 * Agent tools. The terminal only supplies transport and owner-bound effects. */
export class TerminalProjects {
  private active = true;
  private registration!: ReturnType<typeof createProjectRegistration>;
  private management!: ReturnType<typeof createProjectManagement>;
  private context!: () => LocalProjectContext;
  private writes: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(
    private root: string,
    private options: {
      tasks: TerminalTaskHost;
      logger: Logger;
      guard(): void;
      emit(channel: string, payload: unknown): void;
      createSession(directory: string, title: string): Promise<string>;
    },
  ) {
    this.ready = this.open();
  }
  private guard() {
    if (!this.active) throw new Error("PROJECTS_CLOSED");
    this.options.guard();
  }
  private async open() {
    const { tasks, logger } = this.options;
    const [database, conversations] = await Promise.all([
      tasks.database,
      tasks.conversations,
    ]);
    this.guard();
    const snapshot = database.getCurrentDbClientSnapshot(),
      scope = conversations.broadcastTap.captureDataOwnerBroadcastScope();
    const current = () => {
      try {
        this.guard();
        return (
          database.getCurrentDbClientSnapshot() === snapshot &&
          conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope)
        );
      } catch {
        return false;
      }
    };
    const assertCurrent = () => {
      if (!current()) throw new Error("PROJECT_OWNER_CHANGED");
    };
    const emit = (channel: string, payload: unknown) => {
      assertCurrent();
      this.options.emit(channel, payload);
    };
    this.context = () => {
      assertCurrent();
      return {
        client: database.getDbClient(),
        owner: scope.ownerStamp,
        assertCurrent,
      };
    };
    const sidebar = createSidebarSettingsDocument({
      ownerRoot: this.root,
      activeOwnerScopeKey: () => scope.ownerScopeKey,
      log: logger,
    });
    const setHidden = async (
      directory: string,
      hidden: boolean,
      owner: DataOwnerPushStamp,
    ) => {
      assertCurrent();
      if (
        owner.dataOwnerId !== scope.ownerStamp.dataOwnerId ||
        owner.ownerGeneration !== scope.ownerStamp.ownerGeneration
      )
        throw new Error("PROJECT_OWNER_CHANGED");
      let changed = false;
      const pending = this.writes.then(async () => {
        const settings = await sidebar.updateAtomic(
          ({ value }) => {
            assertCurrent();
            const keys = value.hiddenProjectKeys,
              key = identity(directory);
            const matches = (entry: string) =>
              projectKeyComparisonKey(entry, process.platform) === key;
            if (keys.some(matches) === hidden)
              return { hiddenProjectKeys: keys };
            if (hidden && keys.length >= MAX_HIDDEN_PROJECT_ENTRIES)
              throw new Error("INVALID_PARAMS");
            changed = true;
            return {
              hiddenProjectKeys: hidden
                ? [...keys, `local:${directory}`]
                : keys.filter((entry) => !matches(entry)),
            };
          },
          { preserveDefaults: true },
        );
        assertCurrent();
        if (changed) {
          conversations.broadcastLocal(
            "sidebar-settings:hidden-project-keys-changed",
            settings.hiddenProjectKeys,
            scope.ownerStamp,
          );
          conversations.broadcastTap.tapWindowBroadcast(
            "sidebar-settings:hidden-project-keys-changed",
            settings.hiddenProjectKeys,
          );
        }
      });
      this.writes = pending.catch(() => {});
      await pending;
      return changed;
    };
    const aliases = createProjectAliases({
      getDbClient: () => this.context().client,
      ipcMain: { handle: () => {} },
      broadcastProjectAliasesChanged: () =>
        emit("local-db:project-aliases:changed", undefined),
    });
    this.registration = createProjectRegistration({
      logger,
      ...conversations.recent,
      getActiveDataOwnerPushStamp: () => scope.ownerStamp,
      isAppSessionBoundaryPending: () => !current(),
      tryGetDbClient: () => (current() ? database.getDbClient() : null),
      dialogueWorkspaceRoots: () => tasks.dialogueWorkspaceRoots(),
      restoreLocalProjectVisibility: (directory, owner) =>
        setHidden(directory, false, owner),
      broadcastRegistered: (directory) =>
        emit("local-db:recent-workdirs:changed", { path: directory }),
    });
    this.management = createProjectManagement({
      ...this.registration,
      ...conversations.recent,
      ...aliases,
      loadSidebarSettingsSnapshot: () => {
        assertCurrent();
        sidebar.invalidateIfChanged();
        return sidebar.read();
      },
      setLocalProjectHidden: setHidden,
    });
    const move = createProjectMove({
      ...this.registration,
      updateSessionInDb: (...args) =>
        tasks.sessions.service.updateSessionInDb(...args),
      bindingStore: tasks.channelBindings.store,
      assertTaskActionCurrent,
    });
    tasks.configureProjectHelper({
      createProject: this.registration.createProject,
      moveSession: move.createMoveSession((id) => tasks.isTurnRunning(id)),
      projectManagement: {
        list: this.management.listProjects,
        rename: this.management.renameProject,
        remove: this.management.removeProject,
      },
    });
  }
  private async list(includeHidden = false) {
    await this.ready;
    return (
      await this.management.listRegisteredProjects(this.context(), {
        includeHidden,
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      })
    ).projects;
  }
  async directories() {
    return (await this.list()).map((row) => row.workingDir);
  }
  register(registry: RemoteResourceRegistry) {
    const title = (row: Project) => row.alias ?? row.directoryName;
    const item = (row: Project): RemoteCollectionItem => ({
      ref: {
        collectionId: "projects",
        kind: "project",
        id: id(row.workingDir),
      },
      display: { title: title(row), subtitle: row.workingDir },
      links: [],
      revision: JSON.stringify([row.lastUsedAt, row.alias, row.hidden]),
      actions: [
        { id: "open", label: t("open") },
        {
          id: "rename",
          label: t("edit"),
          fields: [
            { id: "name", kind: "text", label: t("name"), required: true },
          ],
        },
        { id: "remove", label: t("remove") },
      ],
    });
    registry.register({
      collection: {
        id: "projects",
        resourceKind: "project",
        title: t("projects"),
        placement: "settings",
        actions: [
          {
            id: "add",
            label: t("add"),
            fields: [
              {
                id: "directory",
                label: t("folder"),
                kind: "text",
                required: true,
              },
              { id: "name", label: t("name"), kind: "text" },
            ],
          },
        ],
      },
      list: async (context, request) => {
        const rows = (await this.list()).filter(
          (row) =>
            !request.query ||
            `${title(row)} ${row.workingDir}`
              .toLowerCase()
              .includes(request.query.toLowerCase()),
        );
        context.assertCurrent?.();
        const offset = request.cursor ? Number(request.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("INVALID_CURSOR");
        const limit = Math.min(request.limit ?? 100, 200);
        return {
          collectionId: "projects",
          revision: createHash("sha256")
            .update(JSON.stringify(rows))
            .digest("hex"),
          items: rows.slice(offset, offset + limit).map(item),
          ...(offset + limit < rows.length
            ? { nextCursor: String(offset + limit) }
            : {}),
        };
      },
      get: async (context, request) => {
        const row = (await this.list(true)).find(
          (row) => id(row.workingDir) === request.ref.id,
        );
        context.assertCurrent?.();
        if (!row) throw new Error("PROJECT_NOT_FOUND");
        return {
          ...item(row),
          blocks: [
            {
              id: "directory",
              primitive: "text",
              fallbackMarkdown: row.workingDir,
            },
            {
              id: "rename",
              primitive: "form",
              fallbackMarkdown: "",
              data: { actionId: "rename", values: { name: title(row) } },
            },
          ],
        };
      },
      invoke: async (context, request) => {
        await this.ready;
        this.guard();
        context.assertCurrent?.();
        const owner = this.context(),
          current = owner.assertCurrent;
        owner.assertCurrent = () => {
          current();
          context.assertCurrent?.();
        };
        if (request.actionId === "add") {
          const input = z
            .object({
              directory: z.string().min(1).refine(path.isAbsolute),
              name: z.string().max(80).optional(),
            })
            .parse(request.input);
          const result = await this.registration.registerProjectDirectory(
            input.directory,
            owner,
          );
          if (!result.ok) throw new Error(result.errorCode);
          if (input.name?.trim())
            await this.management.renameRegisteredProject(
              owner,
              result.workingDir,
              input.name,
            );
        } else {
          const row = (await this.list(true)).find(
            (row) => id(row.workingDir) === request.resourceRef?.id,
          );
          owner.assertCurrent();
          if (!row) throw new Error("PROJECT_NOT_FOUND");
          if (request.actionId === "open") {
            const sessionId = await this.options.createSession(
              row.workingDir,
              title(row),
            );
            return {
              effects: [
                { kind: "navigate", target: { kind: "session", sessionId } },
              ],
            };
          }
          if (request.actionId === "rename")
            await this.management.renameRegisteredProject(
              owner,
              row.workingDir,
              z.string().trim().min(1).max(80).parse(request.input?.name),
            );
          else if (request.actionId === "remove")
            await this.management.removeRegisteredProject(
              owner,
              row.workingDir,
            );
          else throw new Error("INVALID_ACTION");
        }
        return {
          effects: [{ kind: "refresh-collection", collectionId: "projects" }],
        };
      },
    });
  }
  async close() {
    this.active = false;
    this.options.tasks.configureProjectHelper(undefined);
    await this.writes;
  }
}
