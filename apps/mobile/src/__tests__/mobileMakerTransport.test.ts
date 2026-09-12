import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  REMOTE_INVOKE_ALLOWLIST,
} from "@cindy/device-link";
import {
  createMobileMakerTransport,
  MOBILE_MAKER_CHANNELS,
} from "@/device-link/mobileMakerTransport";
import type { RemoteInvoke } from "@/device-link/mobileMakerTransport";
import { installPeerFileDownload } from "@/device-link/peerFileRegistry";
import { resolveMobileRemoteMedia } from "@/session/remoteMedia";
import {
  setMobileAuthOwner,
  __testing as authOwnerTesting,
} from "@/auth/authOwnerGeneration";

function harness() {
  const calls: Array<{ deviceId: string; channel: string; args?: unknown[] }> =
    [];
  const invokeMock = vi.fn(
    async (deviceId: string, channel: string, args?: unknown[]) => {
      calls.push({ deviceId, channel, args });
      return { ok: true };
    },
  );
  const invoke: RemoteInvoke = (deviceId, channel, args) =>
    invokeMock(deviceId, channel, args) as Promise<never>;
  return {
    calls,
    invoke,
    maker: createMobileMakerTransport({ deviceId: "dev-1", invoke }),
  };
}

describe("mobile maker transport", () => {
  it.each(["audio/mpeg", "video/mp4"])("streams %s while preserving peer for complete byte consumers", async (mimeType) => {
    const metadata = { ossKey: "", size: 70_000, mimeType, transferRequired: true };
    const direct = { ...metadata, transferRequired: false };
    const peer = vi.fn(async () => direct);
    const uninstall = installPeerFileDownload(peer);
    const invoke = vi.fn(async (_device, _channel, args) => {
      expect(args[0]).not.toHaveProperty("stream");
      if (args[0].op === "caps") return { fileRead: true };
      if (args[0].op === "fileUrl") return { ok: true, url: "xdt-file://open?path=/media" };
      return args[0].prepareOnly ? metadata : { ...metadata, ossKey: "stream/key", transferRequired: false };
    });
    try {
      const maker = createMobileMakerTransport({ deviceId: "d", invoke: invoke as RemoteInvoke });
      expect((await maker.fetchRemoteMedia("xdt-file://open?path=/media")).ossKey).toBe("stream/key");
      expect(peer).not.toHaveBeenCalled();
      expect(await maker.fileBrowser.readBytes("/p", "media")).toBe(direct);
      expect(peer).toHaveBeenCalledOnce();
      expect(await maker.fetchRemoteMedia("xdt-file://open?path=/media", { stream: false })).toBe(direct);
      expect(peer).toHaveBeenCalledTimes(2);
    } finally { uninstall(); }
  });
  it("does not return old-account OSS keys to a cleanup callback after account change", async () => {
    setMobileAuthOwner("first");
    const onDiscardOssKey = vi.fn();
    const maker = createMobileMakerTransport({
      deviceId: "d",
      invoke: async <T,>() => {
        setMobileAuthOwner("second");
        return { ossKey: "first/key", size: 1, mimeType: "text/html" } as T;
      },
    });
    try {
      await expect(
        maker.fetchRemoteMedia("xdt-file://open?path=/a", { onDiscardOssKey }),
      ).rejects.toThrow("FILE_PEER_CANCELLED");
      expect(onDiscardOssKey).not.toHaveBeenCalled();
    } finally {
      authOwnerTesting.reset();
    }
  });
  it.each([
    ["prepare", "abort"],
    ["prepare", "stale"],
    ["fallback", "abort"],
    ["fallback", "stale"],
  ])(
    "returns late %s OSS ownership before %s cancellation",
    async (phase, reason) => {
      const abort = new AbortController();
      let current = true;
      const uploaded = new Set<string>();
      const remove = vi.fn();
      const presignGet = vi.fn();
      const invoke = vi.fn(async (_device, _channel, args) => {
        expect(args[0]).not.toHaveProperty("onDiscardOssKey");
        if (phase === "fallback" && args[0].prepareOnly)
          return {
            ossKey: "",
            size: 70_000,
            mimeType: "text/html",
            transferRequired: true,
          };
        if (reason === "abort") abort.abort();
        else current = false;
        return {
          ossKey: "owned/late.html",
          size: 70_000,
          mimeType: "text/html",
        };
      });
      const uninstall = installPeerFileDownload(async () => null);
      const maker = createMobileMakerTransport({
        deviceId: "d",
        invoke: (device, channel, args) => invoke(device, channel, args) as Promise<never>,
        isCurrent: () => current,
      });
      const read = async () => {
        try {
          return await resolveMobileRemoteMedia(
            { kind: "image", url: "xdt-file://open?path=/late.html" },
            { fetchRemoteMedia: maker.fetchRemoteMedia, presignGet },
            { signal: abort.signal, onOssKey: (key) => uploaded.add(key) },
          );
        } finally {
          for (const key of uploaded) remove(key);
        }
      };
      try {
        await expect(read()).rejects.toThrow("FILE_PEER_CANCELLED");
        expect(remove).toHaveBeenCalledExactlyOnceWith("owned/late.html");
        expect(presignGet).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledTimes(phase === "prepare" ? 1 : 2);
      } finally {
        uninstall();
      }
    },
  );
  it("uses the shared inline/peer/OSS policy for media files", async () => {
    const direct = { ossKey: "", size: 70_000, mimeType: "text/plain" };
    const peer = vi.fn(async () => direct);
    const uninstall = installPeerFileDownload(peer);
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ossKey: "",
        size: 0,
        mimeType: "text/plain",
        inlineBase64: "",
      })
      .mockResolvedValueOnce({ ...direct, transferRequired: true });
    try {
      const maker = createMobileMakerTransport({ deviceId: "d", invoke });
      expect(
        (await maker.fetchRemoteMedia("xdt-file://open?path=/a")).inlineBase64,
      ).toBe("");
      expect(peer).not.toHaveBeenCalled();
      expect(await maker.fetchRemoteMedia("xdt-file://open?path=/b")).toBe(
        direct,
      );
      expect(peer).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });
  it("cancels before caps and keeps old-host export on the existing job protocol", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, transferId: "job", size: 3 })
      .mockResolvedValueOnce({ ok: true, state: "done", key: "oss/key" });
    const maker = createMobileMakerTransport({ deviceId: "d", invoke });
    const abort = new AbortController();
    abort.abort();
    await expect(
      maker.fileBrowser.readBytes("/p", "a", abort.signal),
    ).rejects.toThrow("CANCELLED");
    expect(invoke).not.toHaveBeenCalled();
    const open = vi.fn(async () => {});
    expect(
      (await maker.fileBrowser.readBytes("/p", "a", undefined, open)).ossKey,
    ).toBe("oss/key");
    expect(open).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.map((call) => call[2][0].op)).toEqual([
      "caps",
      "exportFileStart",
      "exportFileStatus",
    ]);
  });
  it("rejects a legacy unscoped quota response for an independent account", async () => {
    const { maker, calls } = harness();
    await expect(maker.getCodexRateLimits("openai-second")).rejects.toThrow(
      "Account scope unsupported",
    );
    expect(calls.at(-1)).toMatchObject({
      channel: "maker:usage:codex-rate-limits",
      args: ["openai-second"],
    });
    await expect(
      maker.getAccountUsage("codex", "openai-second"),
    ).rejects.toThrow("Account scope unsupported");
  });

  it("accepts only the requested account in scoped quota responses", async () => {
    const invoke: RemoteInvoke = async () =>
      ({ providerId: "openai-second" }) as never;
    const maker = createMobileMakerTransport({ deviceId: "dev-1", invoke });
    await expect(
      maker.getCodexRateLimits("openai-second"),
    ).resolves.toMatchObject({ providerId: "openai-second" });
    await expect(maker.getCodexRateLimits("openai-third")).rejects.toThrow(
      "Account scope unsupported",
    );
  });
  it("documents the remote channels used by the mobile transport", () => {
    expect(MOBILE_MAKER_CHANNELS).toEqual([
      "maker:create-session",
      "maker:get-capabilities",
      "maker:provider:list",
      "local-db:sessions:get",
      "local-db:conversations:search",
      "local-db:sessions:patch-meta",
      "local-db:messages:dismiss-error",
      "local-db:sessions:ack-interrupted",
      "maker:regenerate-title",
      "local-db:messages:list",
      "local-db:messages:view",
      "local-db:messages:work-details",
      "local-db:messages:view-intent",
      "local-db:messages:around",
      "local-db:messages:around-client-id",
      "maker:send",
      "maker:list-active",
      "maker:set-model",
      "maker:switch-session-agent",
      "maker:get-session-agent-switch-intent",
      "maker:set-effort",
      "maker:set-permission-mode",
      "maker:set-fast-mode",
      "maker:set-thinking-enabled",
      "maker:set-extra-dirs",
      "maker:set-session-model-pref",
      "maker:apply-new-maker-draft-pref",
      "maker:get-new-maker-defaults",
      "maker:apply-new-maker-worktree-pref",
      "maker:get-new-maker-worktree-branch-pref",
      "maker:apply-new-maker-worktree-branch-pref",
      "maker:usage:model-pricing",
      "local-db:messages:estimatedSessionValue",
      "maker:usage:codex-rate-limits",
      "maker:usage:codex-rate-limit-reset",
      "maker:api-key:present",
      "maker:list-agent-commands",
      "maker:list-agent-skills",
      "maker:scan-at-resources",
      "device-link:media:fetch",
      "device-link:voice:transcribe",
      "device-link:voice:dictionary-learning",
      "device-link:voice:dictionary:get",
      "maker:get-pending-interactions",
      "maker:resolve-interaction",
      "maker:get-context-usage",
      "maker:goal:set",
      "maker:goal:clear",
      "maker:goal:get-status",
      "maker:goal:pause",
      "maker:goal:resume",
      "maker:goal:update",
      "maker:fork",
      "maker:get-session-tree",
      "maker:navigate-session-tree",
      "maker:rewind:preview",
      "maker:rewind:commit",
      "maker:message:delete",
      "maker:close-session",
      "maker:schedule:list",
      "maker:schedule:get",
      "maker:schedule:list-templates",
      "maker:schedule:create-from-template",
      "maker:schedule:create",
      "maker:schedule:update",
      "maker:schedule:list-runs",
      "maker:schedule:run-now",
      "maker:schedule:pause",
      "maker:schedule:resume",
      "maker:schedule:delete",
      "maker:schedule:get-inflight-count",
      "maker:schedule:mark-run-read",
      "maker:schedule:mark-schedule-runs-read",
      "maker:schedule:delete-run",
      "notification:clear-session-attention",
      "maker:project-automation:remove-schedule",
      "maker:input:get-projection",
      "maker:input:enqueue",
      "maker:input:compact",
      "maker:compact-session",
      "maker:input:steer",
      "maker:input:stop",
      "maker:input:resume",
      "maker:input:retry-last-error",
      "maker:input:clear-error",
      "maker:input:remove",
      "maker:input:update-text",
      "maker:input:update-content",
      "maker:input:move",
      "maker:input:set-expanded",
      "maker:input:set-interaction-lock",
      "maker:input:set-edit-lock",
      "maker:input:clear-session",
      "fs:list-dir",
      "fs:stat-path",
      "fs:mkdir-p",
      "worktree:detect-cwd",
      "worktree:list-branches",
      "worktree:suggest-name",
      "worktree:create",
      "worktree:discard-precreated",
      "text-file:read-preview",
      "file-browser:remote-op",
    ]);
  });

  it("keeps mobile remote channels inside the desktop device-link allowlist", () => {
    expect(
      MOBILE_MAKER_CHANNELS.filter(
        (channel) => !REMOTE_INVOKE_ALLOWLIST.has(channel),
      ),
    ).toEqual([]);
  });

  it("routes tail-banner dismiss and interrupt ack with desktop preload argument order", async () => {
    const { calls, maker } = harness();

    await maker.dismissErrorMessage("s1", "error-client-1");
    await maker.ackInterruptedTurn("s1");

    expect(calls).toEqual([
      {
        channel: "local-db:messages:dismiss-error",
        args: ["s1", "error-client-1"],
        deviceId: "dev-1",
      },
      {
        channel: "local-db:sessions:ack-interrupted",
        args: ["s1"],
        deviceId: "dev-1",
      },
    ]);
  });

  it("routes message reads and sends with desktop preload argument order", async () => {
    const { calls, maker } = harness();

    await maker.listMessages("s1", { limit: 80 });
    await maker.aroundMessages("s1", "message-id", { radius: 60 });
    await maker.aroundMessagesByClientId("s1", "client-id", { radius: 40 });
    await maker.patchSessionMeta("s1", { title: "Renamed" });
    await maker.send("s1", "hello", undefined, { throwOnStartFailure: true });
    await maker.listActiveSessions();

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "local-db:messages:list",
        args: ["s1", { limit: 80 }],
      },
      {
        deviceId: "dev-1",
        channel: "local-db:messages:around",
        args: ["s1", "message-id", { radius: 60 }],
      },
      {
        deviceId: "dev-1",
        channel: "local-db:messages:around-client-id",
        args: ["s1", "client-id", { radius: 40 }],
      },
      {
        deviceId: "dev-1",
        channel: "local-db:sessions:patch-meta",
        args: ["s1", { title: "Renamed" }],
      },
      {
        deviceId: "dev-1",
        channel: "maker:send",
        args: ["s1", "hello", undefined, { throwOnStartFailure: true }],
      },
      {
        deviceId: "dev-1",
        channel: "maker:list-active",
        args: [{ summary: true }],
      },
    ]);
  });

  it("routes remote create-session through the desktop device-link channel", async () => {
    const { calls, maker } = harness();
    const opts = {
      agentKind: "claude-code" as const,
      workingDir: "/repo/xdt-maker",
      workspaceKind: "project" as const,
      model: "claude-sonnet-4-6",
      effort: "medium",
      permissionMode: "acceptEdits",
      fastMode: false,
    };

    await maker.createSession(opts);

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:create-session",
        args: [opts],
      },
    ]);
  });

  it("routes task search through the controlled desktop conversations:search channel", async () => {
    const { calls, maker } = harness();
    const request = { query: "needle", semanticMode: "keyword" as const };

    await maker.searchConversations(request);

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "local-db:conversations:search",
        args: [request],
      },
    ]);
  });

  it("routes capability reads through the controlled desktop maker channel", async () => {
    const { calls, maker } = harness();

    await maker.getCapabilities("claude-code");

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:get-capabilities",
        args: ["claude-code"],
      },
    ]);
  });

  it("mirrors the controlled desktop provider structure via maker:provider:list", async () => {
    const { calls, maker } = harness();

    await maker.listProviders();

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:provider:list",
        args: [
          {
            capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2],
          },
        ],
      },
    ]);
  });

  it("carries providerId into create-session only when a source is explicitly chosen", async () => {
    const { calls, maker } = harness();
    const base = {
      agentKind: "codex" as const,
      workspaceKind: "dialogue" as const,
      model: "gpt-5.5",
      permissionMode: "acceptEdits",
      fastMode: false,
    };

    await maker.createSession({ ...base, providerId: "openai" });

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:create-session",
        args: [{ ...base, providerId: "openai" }],
      },
    ]);
  });

  it("routes pending interactions through maker:resolve-interaction", async () => {
    const { calls, maker } = harness();
    const decision = {
      kind: "ask_user_question",
      answers: { question: "answer" },
    };

    await maker.getPendingInteractions("s1");
    await maker.resolveInteraction("req-1", decision);

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:get-pending-interactions",
        args: ["s1"],
      },
      {
        deviceId: "dev-1",
        channel: "maker:resolve-interaction",
        args: ["req-1", decision],
      },
    ]);
  });

  it("does not advertise or emit the unimplemented model-window confirmation protocol", async () => {
    const contextSource = readFileSync(
      resolve(process.cwd(), "src/device-link/DeviceLinkContext.tsx"),
      "utf8",
    );
    const transportSource = readFileSync(
      resolve(process.cwd(), "src/device-link/mobileMakerTransport.ts"),
      "utf8",
    );
    const { calls, maker } = harness();

    await maker.setModel("s1", "small-model", "anthropic");

    expect(contextSource).not.toContain(
      "CONTROLLER_CAPABILITY_MODEL_WINDOW_CONFIRMATION_V1",
    );
    expect(contextSource).not.toContain("model-window-confirmation-v1");
    expect(transportSource).not.toContain("confirmedOverflow");
    expect(transportSource).not.toContain("confirmedContextWindow");
    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:set-model",
        args: ["s1", "small-model", "anthropic"],
      },
    ]);
  });

  it("sends model/provider/effort/Fast as one atomic set-model selection", async () => {
    const { calls, maker } = harness();

    await maker.setModel("s1", "fixed-model", "provider-a", {
      effort: null,
      fastMode: false,
    });

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:set-model",
        args: [
          "s1",
          "fixed-model",
          "provider-a",
          null,
          { effort: null, fastMode: false },
        ],
      },
    ]);
  });

  it("fails closed when a legacy Desktop returns model-window confirmation data", async () => {
    const invoke: RemoteInvoke = async () =>
      ({
        deferred: false,
        contextWindowConfirmationRequired: 272_000,
        contextTokensForConfirmation: 244_800,
      }) as never;
    const maker = createMobileMakerTransport({ deviceId: "dev-1", invoke });

    await expect(maker.setModel("s1", "pi-model")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "remote model-window confirmation is unsupported; runtime selection was not changed",
    });
  });

  it("routes runtime controls and queue operations with stable channel names", async () => {
    const { calls, maker } = harness();

    await maker.setModel("s1", "claude-opus-4-7");
    await maker.setModel("s1", "gpt-5.5", "openai");
    await maker.switchSessionAgent(
      "s1",
      "codex",
      "gpt-5.5",
      "openai",
      "high",
      true,
    );
    await maker.getSessionAgentSwitchIntent("s1");
    await maker.setEffort("s1", "high");
    await maker.setPermissionMode("s1", "plan");
    await maker.setFastMode("s1", true);
    await maker.setExtraDirs("s1", ["/repo/docs"]);
    await maker.listAgentCommands("claude-code");
    await maker.listAgentCommands("pi", { sessionId: "s1" });
    await maker.listAgentSkills("claude-code", { workingDir: "/repo" });
    await maker.listAgentSkills("pi", { workingDir: "/repo", sessionId: "s1" });
    await maker.listAgentSkills("codex", {});
    await maker.scanAtResources("claude-code", {
      workingDir: "/repo",
      cap: 2000,
      query: "session",
    });
    await maker.fetchRemoteMedia("xdt-image://local/a.png");
    await maker.transcribeVoice({
      ossKey: "voice-key",
      mimeType: "audio/mp4",
      fileName: "voice.m4a",
    });
    await maker.recordVoiceDictionaryLearning({
      source: "mobile",
      rawTranscriptText: "xd maker",
      beforeText: "XDMaker",
      afterText: "XDMaker",
    });
    await maker.getVoiceDictionary();
    await maker.input.stop("s1", { pauseQueue: true });
    await maker.input.compact("s1");
    await maker.compactSession("s1");
    await maker.compactSession("s1", "");
    await maker.compactSession("s1", "focus on API design");
    await maker.input.retryLastError("s1");
    await maker.input.clearError("s1");
    await maker.input.updateText("s1", "queued-1", "updated");
    await maker.input.updateContent("s1", "queued-1", {
      clientId: "queued-1",
    } as never);
    await maker.input.setEditLock("s1", "queued-1", true);
    await maker.input.setEditLock("s1", "queued-1", false);
    await maker.fs.readTextFilePreview("/repo/spec.md");
    await maker.getModelPricing();
    await maker.getCodexRateLimits();
    await maker.resetCodexRateLimits("018f4ec7-c6d8-7f10-8d43-9f8791d33000");
    await maker.getApiKeyPresent();
    await maker.setSessionModelPref({
      sessionId: "s1",
      agent: "codex",
      providerId: "openai",
      model: "gpt-5.5",
      effort: "high",
    });
    await maker.applyNewMakerDraftPref({
      agent: "codex",
      providerId: "openai",
      modelId: "gpt-5.5",
      active: false,
      fast: true,
    });

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["maker:set-model", ["s1", "claude-opus-4-7"]],
      ["maker:set-model", ["s1", "gpt-5.5", "openai"]],
      [
        "maker:switch-session-agent",
        ["s1", "codex", "gpt-5.5", "openai", "high", true],
      ],
      ["maker:get-session-agent-switch-intent", ["s1"]],
      ["maker:set-effort", ["s1", "high"]],
      ["maker:set-permission-mode", ["s1", "plan"]],
      ["maker:set-fast-mode", ["s1", true]],
      ["maker:set-extra-dirs", ["s1", ["/repo/docs"]]],
      ["maker:list-agent-commands", ["claude-code"]],
      ["maker:list-agent-commands", ["pi", { sessionId: "s1" }]],
      ["maker:list-agent-skills", ["claude-code", { workingDir: "/repo" }]],
      [
        "maker:list-agent-skills",
        ["pi", { workingDir: "/repo", sessionId: "s1" }],
      ],
      ["maker:list-agent-skills", ["codex", {}]],
      [
        "maker:scan-at-resources",
        ["claude-code", { workingDir: "/repo", cap: 2000, query: "session" }],
      ],
      [
        "device-link:media:fetch",
        [{ url: "xdt-image://local/a.png", prepareOnly: true }],
      ],
      [
        "device-link:voice:transcribe",
        [{ ossKey: "voice-key", mimeType: "audio/mp4", fileName: "voice.m4a" }],
      ],
      [
        "device-link:voice:dictionary-learning",
        [
          {
            source: "mobile",
            rawTranscriptText: "xd maker",
            beforeText: "XDMaker",
            afterText: "XDMaker",
          },
        ],
      ],
      ["device-link:voice:dictionary:get", []],
      ["maker:input:stop", ["s1", { pauseQueue: true }]],
      ["maker:input:compact", ["s1"]],
      ["maker:compact-session", ["s1"]],
      ["maker:compact-session", ["s1", ""]],
      ["maker:compact-session", ["s1", "focus on API design"]],
      ["maker:input:retry-last-error", ["s1"]],
      ["maker:input:clear-error", ["s1"]],
      ["maker:input:update-text", ["s1", "queued-1", "updated"]],
      [
        "maker:input:update-content",
        ["s1", "queued-1", { clientId: "queued-1" }],
      ],
      ["maker:input:set-edit-lock", ["s1", "queued-1", true]],
      ["maker:input:set-edit-lock", ["s1", "queued-1", false]],
      ["text-file:read-preview", [{ filePath: "/repo/spec.md" }]],
      ["maker:usage:model-pricing", []],
      ["maker:usage:codex-rate-limits", []],
      [
        "maker:usage:codex-rate-limit-reset",
        ["018f4ec7-c6d8-7f10-8d43-9f8791d33000"],
      ],
      ["maker:api-key:present", []],
      [
        "maker:set-session-model-pref",
        [
          {
            sessionId: "s1",
            agent: "codex",
            providerId: "openai",
            model: "gpt-5.5",
            effort: "high",
          },
        ],
      ],
      [
        "maker:apply-new-maker-draft-pref",
        [
          {
            agent: "codex",
            providerId: "openai",
            modelId: "gpt-5.5",
            active: false,
            fast: true,
          },
        ],
      ],
    ]);
  });

  it("routes worktree probes and new-maker worktree defaults with device-link argument shapes", async () => {
    const { calls, maker } = harness();

    await maker.getNewMakerDefaults("claude-code");
    await maker.applyNewMakerWorktreePref(true);
    await maker.getNewMakerWorktreeBranchPref("/repo");
    await maker.applyNewMakerWorktreeBranchPref("/repo", "feature/mobile-sync");
    await maker.worktree.detectCwd("/repo/app");
    await maker.worktree.listBranches("/repo");
    await maker.worktree.suggestName("/repo");
    await maker.worktree.create({
      sessionId: "preset-session-1",
      baseRepo: "/repo",
      name: "auto-abc123",
      sourceBranch: "main",
      recoveryKey: "recovery-key-1234567890",
    });
    await maker.worktree.discardPrecreated({
      sessionId: "preset-session-1",
      path: "/repo/.cindy-worktrees/auto-abc123",
    });
    await maker.worktree.discardPrecreated({
      sessionId: "preset-session-2",
      recoveryKey: "recovery-key-0987654321",
    });

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["maker:get-new-maker-defaults", ["claude-code"]],
      ["maker:apply-new-maker-worktree-pref", [{ worktreeEnabled: true }]],
      ["maker:get-new-maker-worktree-branch-pref", [{ baseRepo: "/repo" }]],
      [
        "maker:apply-new-maker-worktree-branch-pref",
        [
          {
            baseRepo: "/repo",
            sourceBranch: "feature/mobile-sync",
          },
        ],
      ],
      ["worktree:detect-cwd", [{ cwd: "/repo/app" }]],
      ["worktree:list-branches", [{ baseRepo: "/repo" }]],
      ["worktree:suggest-name", [{ baseRepo: "/repo" }]],
      [
        "worktree:create",
        [
          {
            sessionId: "preset-session-1",
            baseRepo: "/repo",
            name: "auto-abc123",
            sourceBranch: "main",
            recoveryKey: "recovery-key-1234567890",
          },
        ],
      ],
      [
        "worktree:discard-precreated",
        [
          {
            sessionId: "preset-session-1",
            path: "/repo/.cindy-worktrees/auto-abc123",
          },
        ],
      ],
      [
        "worktree:discard-precreated",
        [
          {
            sessionId: "preset-session-2",
            recoveryKey: "recovery-key-0987654321",
          },
        ],
      ],
    ]);
  });

  it("routes fork, native tree, rewind and delete actions through maker namespace", async () => {
    const { calls, maker } = harness();

    await maker.fork("s1", "m2");
    await maker.getSessionTree("s1");
    await maker.navigateSessionTree("s1", "entry-2", {
      summarize: true,
      customInstructions: "Keep the decision context",
    });
    await maker.rewindPreview("s1", "m2");
    await maker.rewindCommit("s1", "m2");
    await maker.deleteMessage("s1", "m2");

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["maker:fork", ["s1", "m2"]],
      ["maker:get-session-tree", ["s1"]],
      [
        "maker:navigate-session-tree",
        [
          "s1",
          "entry-2",
          {
            summarize: true,
            customInstructions: "Keep the decision context",
          },
        ],
      ],
      ["maker:rewind:preview", ["s1", "m2"]],
      ["maker:rewind:commit", ["s1", "m2"]],
      ["maker:message:delete", ["s1", "m2"]],
    ]);
  });

  it("passes trusted reference coordinates after update-text in desktop argument order", async () => {
    const { calls, maker } = harness();
    const refs = [
      {
        sessionId: "source",
        messageClientId: "anchor",
        deviceId: "dev-source",
      },
    ];
    const contexts = [
      {
        sessionId: "source",
        messageClientId: "anchor",
        source: "device-link" as const,
        deviceId: "dev-source",
        messages: [{ role: "user" as const, content: "trusted" }],
        range: "around-anchor" as const,
        messageCount: 1,
        truncated: false,
      },
    ];

    await maker.input.updateText(
      "target",
      "queued-1",
      "edited",
      refs,
      contexts,
    );

    expect(calls).toEqual([
      {
        deviceId: "dev-1",
        channel: "maker:input:update-text",
        args: ["target", "queued-1", "edited", refs, contexts],
      },
    ]);
  });

  it("routes the session read receipt with desktop preload argument order", async () => {
    const { calls, maker } = harness();

    await maker.clearSessionAttention("s1", "explicit");

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["notification:clear-session-attention", ["s1", "explicit"]],
    ]);
  });

  it("routes scheduler actions with desktop preload argument order", async () => {
    const { calls, maker } = harness();

    await maker.schedule.list();
    await maker.schedule.list({ status: "paused" });
    await maker.schedule.get("sched-1");
    await maker.schedule.listTemplates();
    await maker.schedule.createFromTemplate({
      templateId: "standup-summary",
      paramValues: { project: "XDMaker" },
      overrides: { workingDir: "/repo" },
    });
    await maker.schedule.create({
      name: "Created",
      prompt: "run",
      kind: "cron",
      cronExpr: "*/10 * * * *",
      timezone: "Asia/Shanghai",
      recurring: true,
      intervalMs: 600_000,
      agentKind: "claude-code",
      workspaceKind: "project",
      workingDir: "/repo",
      useWorktree: false,
      notify: { desktop: true, feishu: false },
    });
    await maker.schedule.update("sched-1", { name: "Updated" });
    await maker.schedule.listRuns("sched-1", 50);
    await maker.schedule.runNow("sched-1");
    await maker.schedule.pause("sched-1");
    await maker.schedule.resume("sched-1");
    await maker.schedule.delete("sched-1");
    await maker.schedule.getInflightCount("sched-1");
    await maker.schedule.markRunRead("run-1");
    await maker.schedule.markScheduleRunsRead("sched-1");
    await maker.schedule.deleteRun("run-1");
    await maker.projectAutomation.removeSchedule({
      workingDir: "/repo",
      id: "daily",
    });

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["maker:schedule:list", []],
      ["maker:schedule:list", [{ status: "paused" }]],
      ["maker:schedule:get", ["sched-1"]],
      ["maker:schedule:list-templates", []],
      [
        "maker:schedule:create-from-template",
        [
          {
            templateId: "standup-summary",
            paramValues: { project: "XDMaker" },
            overrides: { workingDir: "/repo" },
          },
        ],
      ],
      [
        "maker:schedule:create",
        [
          {
            name: "Created",
            prompt: "run",
            kind: "cron",
            cronExpr: "*/10 * * * *",
            timezone: "Asia/Shanghai",
            recurring: true,
            intervalMs: 600_000,
            agentKind: "claude-code",
            workspaceKind: "project",
            workingDir: "/repo",
            useWorktree: false,
            notify: { desktop: true, feishu: false },
          },
        ],
      ],
      ["maker:schedule:update", ["sched-1", { name: "Updated" }]],
      ["maker:schedule:list-runs", ["sched-1", 50]],
      ["maker:schedule:run-now", ["sched-1"]],
      ["maker:schedule:pause", ["sched-1"]],
      ["maker:schedule:resume", ["sched-1"]],
      ["maker:schedule:delete", ["sched-1"]],
      ["maker:schedule:get-inflight-count", ["sched-1"]],
      ["maker:schedule:mark-run-read", ["run-1"]],
      ["maker:schedule:mark-schedule-runs-read", ["sched-1"]],
      ["maker:schedule:delete-run", ["run-1"]],
      [
        "maker:project-automation:remove-schedule",
        [{ workingDir: "/repo", id: "daily" }],
      ],
    ]);
  });

  it("routes remote filesystem browse calls with device-link fs handler argument shape", async () => {
    const { calls, maker } = harness();

    await maker.fs.listDir("~");
    await maker.fs.statPath("/repo/app");
    await maker.fs.mkdirP("/repo/new-app");

    expect(calls.map((call) => [call.channel, call.args])).toEqual([
      ["fs:list-dir", [{ path: "~" }]],
      ["fs:stat-path", [{ path: "/repo/app" }]],
      ["fs:mkdir-p", [{ path: "/repo/new-app" }]],
    ]);
  });

  it("routes full file-browser ops through the aggregate remote-op channel", async () => {
    const { calls, maker } = harness();
    const wd = "/repo/project";

    await maker.fileBrowser.caps(wd);
    await maker.fileBrowser.listDir(wd, "apps/mobile");
    await maker.fileBrowser.listDir(wd, "dist", {
      includeIgnored: true,
      maxEntries: 2000,
    });
    await maker.fileBrowser.readFile(wd, "AGENTS.md", { acceptGzip: true });
    await maker.fileBrowser.readFile(wd, "AGENTS.md");
    await maker.fileBrowser.listAllFiles(wd, 20000);
    await maker.fileBrowser.searchCollect(wd, "UsageTracker", {
      maxMatches: 200,
    });
    await maker.fileBrowser.thumbnail(wd, "logo.png");
    await maker.fileBrowser.exportFileStart(wd, "big.bin");
    await maker.fileBrowser.exportFileStatus(wd, "exp_1");

    expect(calls.map((call) => call.channel)).toEqual(
      Array(10).fill("file-browser:remote-op"),
    );
    expect(calls.map((call) => call.args)).toEqual([
      [{ op: "caps", workdir: wd }],
      [{ op: "listDir", workdir: wd, relPath: "apps/mobile" }],
      [
        {
          op: "listDir",
          workdir: wd,
          relPath: "dist",
          includeIgnored: true,
          maxEntries: 2000,
        },
      ],
      [{ op: "readFile", workdir: wd, relPath: "AGENTS.md", acceptGzip: true }],
      [{ op: "readFile", workdir: wd, relPath: "AGENTS.md" }],
      [{ op: "listAllFiles", workdir: wd, cap: 20000 }],
      [
        {
          op: "searchCollect",
          workdir: wd,
          query: "UsageTracker",
          maxMatches: 200,
        },
      ],
      [{ op: "thumbnail", workdir: wd, relPath: "logo.png" }],
      [{ op: "exportFileStart", workdir: wd, relPath: "big.bin" }],
      [{ op: "exportFileStatus", workdir: wd, transferId: "exp_1" }],
    ]);
  });

  it("fails before invoking when the target device id is missing", async () => {
    const invokeMock = vi.fn();
    const invoke: RemoteInvoke = (deviceId, channel, args) =>
      invokeMock(deviceId, channel, args) as Promise<never>;
    const maker = createMobileMakerTransport({ deviceId: "", invoke });

    await expect(maker.listMessages("s1")).rejects.toThrow(
      "remote device id is required",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
