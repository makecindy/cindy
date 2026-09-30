import { compareTaskTags, TASK_TAG_COLORS, TASK_TAG_PRESETS, type TaskTag, type TaskTagRequest, type TaskTagResult } from "@cindy/maker-shared";
import type { SessionMetaPatch } from "@/device-link/mobileMakerTransport";
import type { RemoteSession } from "@/session/types";

// Fixture DTOs contain only JSON values; works in Hermes without structuredClone.
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Per simulated host, in memory only. Reloading JS resets the fixture. */
export class VisualMockSessionState {
  private sessions: RemoteSession[];
  private tags: TaskTag[];
  private nextTagId = 0;

  constructor(sessions: RemoteSession[]) {
    this.sessions = clone(sessions);
    this.tags = Array.from(new Map(sessions.flatMap((s) => s.tags ?? []).map((t) => [t.id, { ...t }])).values());
  }

  list(status?: string): RemoteSession[] {
    return clone(this.sessions.filter((s) => {
      if (status === "all") return s.status !== "deleted";
      if (status === "automation") return s.source === "scheduler" && s.status === "active";
      return s.status === (status ?? "active");
    }));
  }

  get(id: string): RemoteSession {
    const session = this.sessions.find((s) => s.id === id && s.status !== "deleted");
    if (!session) return fail("NOT_FOUND");
    return clone(session);
  }

  patch(id: string, patch: SessionMetaPatch): RemoteSession {
    const current = this.get(id);
    if (Object.keys(patch).some((k) => !["title", "status", "pinnedAt"].includes(k)) ||
      (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 500)) ||
      (patch.status !== undefined && !["active", "archived", "deleted"].includes(patch.status)) ||
      (patch.pinnedAt != null && !Number.isFinite(Date.parse(patch.pinnedAt)))) fail("INVALID_PARAMS");
    const updated = { ...current, ...patch };
    this.sessions = this.sessions.map((s) => s.id === id ? updated : s);
    return clone(updated);
  }

  execute(request: TaskTagRequest): TaskTagResult {
    let affected: string[] = [];
    let deletion: TaskTagResult["deletion"];
    let hasMore: boolean | undefined;
    const tag = (id: string) => this.tags.find((t) => t.id === id) ?? fail("NOT_FOUND");
    const associated = (id: string) => this.sessions.filter((s) => s.status !== "deleted" && s.tags?.some((t) => t.id === id));
    const validate = (name: string, color: TaskTag["color"], except?: string) => {
      if (!name.trim() || name.trim().length > 80 || (color !== "none" && !TASK_TAG_COLORS.includes(color))) fail("INVALID_PARAMS");
      if (this.tags.some((t) => t.id !== except && t.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) fail("ALREADY_EXISTS");
    };
    const favoriteOrder = () => {
      const favorites = this.tags.filter((t) => t.favoriteOrder !== null);
      if (favorites.length >= 7) fail("FAVORITES_FULL");
      return Math.max(-1, ...favorites.map((t) => t.favoriteOrder!)) + 1;
    };
    switch (request.action) {
      case "list": break;
      case "get":
        request.sessionIds.forEach((id) => this.get(id));
        affected = request.sessionIds;
        break;
      case "create": {
        validate(request.name, request.color);
        if (this.tags.length >= 256) fail("LIMIT_EXCEEDED");
        if (request.presetId && !TASK_TAG_PRESETS.some((p) => p.id === request.presetId && p.name === request.name && p.color === request.color)) fail("INVALID_PARAMS");
        const order = request.favorite ? favoriteOrder() : null;
        let id: string;
        do { id = "visual-tag-" + ++this.nextTagId; } while (this.tags.some((t) => t.id === id));
        id = request.presetId ?? id;
        if (this.tags.some((t) => t.id === id)) fail("ALREADY_EXISTS");
        this.tags.push({ id, name: request.name.trim(), color: request.color === "none" ? "white" : request.color, favoriteOrder: order,
          sortOrder: Math.max(-1, ...this.tags.map((t) => t.sortOrder ?? -1)) + 1, revision: 1 });
        break;
      }
      case "update": {
        const current = tag(request.tagId);
        if (current.revision !== request.revision) fail("CONFLICT");
        const name = request.name?.trim() ?? current.name;
        validate(name, request.color ?? current.color, current.id);
        const order = request.favorite === false ? null : request.favorite && current.favoriteOrder === null ? favoriteOrder() : current.favoriteOrder;
        const color = request.color ?? current.color;
        Object.assign(current, { name, color: color === "none" ? "white" : color, favoriteOrder: order,
          nameCustomized: current.nameCustomized || request.nameCustomized || name !== current.name, revision: current.revision + 1 });
        break;
      }
      case "reorder": {
        const current = [...this.tags].sort(compareTaskTags).map((t) => t.id);
        if (JSON.stringify(current) !== JSON.stringify(request.expectedOrder)) fail("CONFLICT");
        if (new Set(request.tagIds).size !== current.length || request.tagIds.length !== current.length || request.tagIds.some((id) => !current.includes(id))) fail("INVALID_PARAMS");
        request.tagIds.forEach((id, i) => { const t = tag(id); if (t.sortOrder !== i) { t.sortOrder = i; t.revision++; } });
        break;
      }
      case "attach":
      case "detach": {
        const sessions = request.sessionIds.map((id) => this.get(id));
        request.tagIds.forEach(tag);
        if (request.action === "attach" && sessions.some((s) => new Set([...(s.tags ?? []).map((t) => t.id), ...request.tagIds]).size > 32)) fail("LIMIT_EXCEEDED");
        affected = request.sessionIds;
        for (const s of this.sessions.filter((s) => affected.includes(s.id))) {
          const ids = new Set((s.tags ?? []).map((t) => t.id));
          for (const id of request.tagIds) {
            if (request.action === "attach" ? !ids.has(id) : ids.has(id)) {
              if (request.action === "attach") ids.add(id); else ids.delete(id);
              tag(id).revision++;
            }
          }
          s.tags = [...ids].map(tag);
        }
        break;
      }
      case "previewDelete": {
        const current = tag(request.tagId);
        deletion = { tagId: current.id, revision: current.revision, count: associated(current.id).length };
        break;
      }
      case "delete": {
        const current = tag(request.tagId);
        if (current.revision !== request.revision || request.expectedCount !== associated(current.id).length) fail("CONFLICT");
        this.tags = this.tags.filter((t) => t.id !== current.id);
        break;
      }
      case "find": {
        tag(request.tagId);
        const offset = request.offset ?? 0, limit = request.limit ?? 50;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("INVALID_PARAMS");
        const matches = associated(request.tagId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        affected = matches.slice(offset, offset + limit).map((s) => s.id);
        hasMore = matches.length > offset + limit;
        break;
      }
      default: fail("INVALID_PARAMS");
    }
    this.tags.sort(compareTaskTags);
    this.sessions = this.sessions.map((s) => ({ ...s, tags: this.tags.filter((t) => s.tags?.some((old) => old.id === t.id)) }));
    return clone({ tags: this.tags, supportedColors: [...TASK_TAG_COLORS],
      sessions: affected.map((id) => ({ sessionId: id, tags: this.get(id).tags ?? [] })),
      ...(deletion ? { deletion } : {}), ...(hasMore !== undefined ? { hasMore } : {}) });
  }
}
