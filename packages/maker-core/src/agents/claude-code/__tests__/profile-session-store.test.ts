import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProfileSessionStore } from "../profile-session-store.js";
import { sanitizeClaudeProjectKey } from "../claude-projects-fs.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unsafe test cleanup");
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe("official SDK fork in a custom Claude profile", () => {
  it("forks the selected profile and keeps the other profile and source transcript unchanged", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cindy-profile-fork-"),
    );
    roots.push(root);
    const cwd = path.join(root, "work");
    const id = randomUUID();
    const uuid = randomUUID();
    const sourceText =
      JSON.stringify({
        type: "user",
        uuid,
        parentUuid: null,
        sessionId: id,
        cwd,
        message: { role: "user", content: "profile A" },
        timestamp: new Date().toISOString(),
      }) + "\n";
    const project = path.join(
      root,
      "account-a",
      "projects",
      sanitizeClaudeProjectKey(cwd),
    );
    const otherProject = path.join(
      root,
      "account-b",
      "projects",
      sanitizeClaudeProjectKey(cwd),
    );
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(otherProject, { recursive: true });
    await fs.writeFile(path.join(project, id + ".jsonl"), sourceText);
    await fs.writeFile(
      path.join(otherProject, id + ".jsonl"),
      "other account\n",
    );
    const store = await claudeProfileSessionStore(
      path.dirname(project),
      id,
      cwd,
    );
    const fork = await forkSession(id, {
      dir: cwd,
      sessionStore: store,
      upToMessageId: uuid,
    });
    const child = JSON.parse(
      (await fs.readFile(path.join(project, fork.sessionId + ".jsonl"), "utf8"))
        .trim()
        .split("\n")[0],
    );
    expect(child.message.content).toBe("profile A");
    expect(child.sessionId).toBe(fork.sessionId);
    expect(await fs.readFile(path.join(project, id + ".jsonl"), "utf8")).toBe(
      sourceText,
    );
    expect(await fs.readdir(otherProject)).toEqual([id + ".jsonl"]);
    expect(
      await fs.readFile(path.join(otherProject, id + ".jsonl"), "utf8"),
    ).toBe("other account\n");
  });
  it("rejects a path masquerading as a source session id", async () => {
    await expect(
      claudeProfileSessionStore("/unused", "../credentials"),
    ).rejects.toThrow("Invalid Claude session id");
  });
});
