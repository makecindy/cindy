import path from "node:path";
import {
  normalizeGhostWorkdirPrefs,
  normalizeWorkdirKey,
  type GhostWorkdirPrefs,
} from "@cindy/plugin-runtime/ghostWorkdirPrefs";
import {
  atomicPrivateWriteSync,
  readPrivateFile,
  privateDirectory,
} from "../platform.js";

export class TerminalPluginPreferences {
  private value: GhostWorkdirPrefs = { disabledByWorkdir: {} };
  private hiddenSidebar: string[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly guard: () => void,
  ) {}
  refresh() {
    const next=this.writes.then(()=>this.load());
    this.writes=next.catch(()=>{});
    return next;
  }
  private async load() {
    this.guard();
    const [bytes, sidebar] = await Promise.all([
      readPrivateFile(path.join(this.root, "ghost-workdir-prefs.json")),
      readPrivateFile(path.join(this.root, "ghost-sidebar-prefs.json")),
    ]);
    this.guard();
    this.value = normalizeGhostWorkdirPrefs(
      bytes ? JSON.parse(bytes.toString()) : {},
    );
    const hidden: unknown = sidebar ? JSON.parse(sidebar.toString()) : [];
    if (!Array.isArray(hidden) || hidden.some((id) => typeof id !== "string"))
      throw new Error("PLUGIN_PREFERENCES_INVALID");
    this.hiddenSidebar = hidden;
  }
  disabled(id: string, workdir: string | null) {
    this.guard();
    return (
      !!workdir &&
      Boolean(
        this.value.disabledByWorkdir[normalizeWorkdirKey(workdir)]?.includes(
          id,
        ),
      )
    );
  }
  disabledIds(workdir: string) {
    this.guard();
    return [
      ...(this.value.disabledByWorkdir[normalizeWorkdirKey(workdir)] ?? []),
    ];
  }
  sidebarVisible(id: string) {
    this.guard();
    return !this.hiddenSidebar.includes(id);
  }
  setSidebarVisible(id: string, visible: boolean, current: () => void) {
    const next = this.writes.then(async () => {
      await privateDirectory(this.root);
      await this.load();
      this.guard();
      current();
      const hidden = new Set(this.hiddenSidebar);
      visible ? hidden.delete(id) : hidden.add(id);
      const value = [...hidden].sort();
      atomicPrivateWriteSync(
        path.join(this.root, "ghost-sidebar-prefs.json"),
        JSON.stringify(value),
      );
      this.hiddenSidebar = value;
    });
    this.writes = next.catch(() => {});
    return next;
  }
  set(
    workdir: string,
    id: string,
    disabled: boolean,
    current: () => void = () => {},
  ) {
    const next = this.writes.then(async () => {
      this.guard();
      const key = normalizeWorkdirKey(workdir);
      if (!key) throw new Error("WORKDIR_REQUIRED");
      await privateDirectory(this.root);
      await this.load();
      this.guard();
      current();
      const value = structuredClone(this.value),
        ids = new Set(value.disabledByWorkdir[key] ?? []);
      disabled ? ids.add(id) : ids.delete(id);
      if (ids.size) value.disabledByWorkdir[key] = [...ids].sort();
      else delete value.disabledByWorkdir[key];
      atomicPrivateWriteSync(
        path.join(this.root, "ghost-workdir-prefs.json"),
        JSON.stringify(value),
      );
      this.value = value;
      return value.disabledByWorkdir[key] ?? [];
    });
    this.writes = next.catch(() => {});
    return next;
  }
}
