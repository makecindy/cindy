/** Adapter for official SDK session mutations in a selected CLI profile.
 * It changes neither process.env nor the SDK's transcript/fork semantics.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SessionStore,
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { findClaudeSessionJsonl } from "./claude-projects-fs.js";

export async function claudeProfileSessionStore(
  projectsRoot: string,
  sourceId: string,
  workingDir?: string,
): Promise<SessionStore> {
  if (!/^[a-f0-9-]{36}$/i.test(sourceId))
    throw new Error("Invalid Claude session id");
  const source = await findClaudeSessionJsonl(
    sourceId,
    workingDir,
    projectsRoot,
  );
  if (!source) throw new Error("Claude session is unavailable in this account");
  const project = path.dirname(source);
  const filename = (key: SessionKey): string => {
    if (!/^[a-f0-9-]{36}$/i.test(key.sessionId))
      throw new Error("Invalid Claude session id");
    if (
      key.subpath &&
      (path.isAbsolute(key.subpath) ||
        key.subpath
          .split(/[\\/]/)
          .some((part) => part === ".." || part === "."))
    )
      throw new Error("Invalid Claude session subpath");
    return key.subpath
      ? path.join(project, key.sessionId, key.subpath)
      : path.join(project, `${key.sessionId}.jsonl`);
  };
  return {
    async load(key) {
      try {
        return (await fs.readFile(filename(key), "utf8"))
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as SessionStoreEntry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async append(key, entries) {
      const file = filename(key);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.appendFile(
        file,
        entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
        { mode: 0o600 },
      );
    },
    async listSubkeys(key) {
      const root = path.join(project, key.sessionId);
      const paths: string[] = [];
      const visit = async (dir: string) => {
        for (const entry of await fs
          .readdir(dir, { withFileTypes: true })
          .catch(() => [])) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (entry.isFile() && entry.name.endsWith(".jsonl"))
            paths.push(path.relative(root, file).split(path.sep).join("/"));
        }
      };
      await visit(root);
      return paths;
    },
  };
}
