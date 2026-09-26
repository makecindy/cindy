import { describe, expect, it } from "vitest";
import {
  TASK_MIGRATION_CHANNEL,
  TASK_MIGRATION_LOCAL_CHANNEL,
  parseTaskMigrationRequest,
} from "../taskMigration.js";
import { REMOTE_INVOKE_ALLOWLIST } from "../allowlist.js";
import {
  isCompletedInvokeRetryableReadChannel,
  isPeerResetRetryableReadChannel,
  resolveRemoteInvokeTimeoutMs,
} from "../invokePolicy.js";

describe("task migration protocol", () => {
  it("accepts only explicit project or dialogue moves on the narrow host action", () => {
    for (const workingDir of [null, "/projects/new", "C:/projects/new"])
      expect(parseTaskMigrationRequest({ action: "move-project", sessionId: "task", workingDir })).toEqual({ action: "move-project", sessionId: "task", workingDir });
    for (const workingDir of [undefined, "", "bad\0path", 12])
      expect(() => parseTaskMigrationRequest({ action: "move-project", sessionId: "task", workingDir })).toThrow();
  });
  it("exposes only the narrow remote business channel, without automatic write retries", () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(TASK_MIGRATION_CHANNEL)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(TASK_MIGRATION_LOCAL_CHANNEL)).toBe(
      false,
    );
    expect(isPeerResetRetryableReadChannel(TASK_MIGRATION_CHANNEL)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(TASK_MIGRATION_CHANNEL)).toBe(
      false,
    );
    for (const platform of ["desktop", "mobile"] as const) {
      expect(
        resolveRemoteInvokeTimeoutMs(
          TASK_MIGRATION_CHANNEL,
          [{ action: "receive" }],
          platform,
        ),
      ).toBe(30 * 60_000);
      expect(
        resolveRemoteInvokeTimeoutMs(
          TASK_MIGRATION_CHANNEL,
          [{ action: "status" }],
          platform,
        ),
      ).toBe(30_000);
    }
  });
  it("rejects unsafe identifiers and invalid sizes without a fixed total limit", () => {
    for (const sessionId of ["../other", "", "a/b", "a\\b"])
      expect(() =>
        parseTaskMigrationRequest({
          action: "start",
          sessionId,
          targetDeviceId: "B",
        }),
      ).toThrow();
    const file = { ref: "reference", size: 100, sha256: "a".repeat(64) };
    const receive = {
      action: "receive",
      id: "01234567-0123-4123-a123-012345678901",
      sourceSessionId: "source",
      targetProject: null,
      files: { session: file, manifest: file, workspace: file },
    };
    expect(parseTaskMigrationRequest(receive)).toEqual(receive);
    expect(
      parseTaskMigrationRequest({
        ...receive,
        files: {
          ...receive.files,
          additionalWorkspaces: [{ workspace: file, repository: file }],
        },
      }),
    ).toBeDefined();
    for (const additionalWorkspaces of [
      null,
      {},
      [null],
      [{}],
      [{ workspace: { ...file, size: -1 } }],
    ])
      expect(() =>
        parseTaskMigrationRequest({
          ...receive,
          files: { ...receive.files, additionalWorkspaces },
        }),
      ).toThrow();
    expect(
      parseTaskMigrationRequest({
        ...receive,
        files: {
          ...receive.files,
          session: { ...file, size: 512 * 1024 ** 2 },
          workspace: {
            size: 6 * 1024 ** 3,
            parts: Array.from({ length: 3 }, () => ({
              ...file,
              size: 2 * 1024 ** 3,
            })),
          },
        },
      }),
    ).toBeDefined();
    for (const size of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        parseTaskMigrationRequest({
          ...receive,
          files: { ...receive.files, workspace: { ...file, size } },
        }),
      ).toThrow();
    expect(() =>
      parseTaskMigrationRequest({
        ...receive,
        files: { ...receive.files, workspace: { size: 101, parts: [file] } },
      }),
    ).toThrow();
    expect(() =>
      parseTaskMigrationRequest({ ...receive, targetProject: "bad\0path" }),
    ).toThrow();
  });
});
