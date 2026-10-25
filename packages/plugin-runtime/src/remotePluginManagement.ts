import { extractIpcError } from "@cindy/remote-agent/shared/ipcError";
import { createHash, randomUUID } from "node:crypto";
import type {
  RemoteActionInvokeRequest,
  RemoteActionInvokeResponse,
} from "@cindy/device-link";
import {
  isGhostInstallApprovalToken,
  ghostInstallApprovalToken,
  type InstalledGhost,
} from "./shared/ghost.js";
import { installedGhostStoragePart } from "./shared/pluginIdentity.js";
import type {
  PluginMarketDetail,
  PluginMarketInstallOptions,
  PluginMarketSnapshot,
} from "./shared/pluginMarket.js";
import type {
  PluginManagementProject,
  PluginManagementProjectState,
  PluginManagementReceipt,
} from "./shared/pluginManagement.js";
import type { GhostInstallConsentPrompt } from "./ghostInstallConsent.js";
import { RemoteResourceRegistryError } from "@cindy/device-link";
import type { RemotePluginPreferences } from "./remotePluginPreferences.js";
import type { RemotePluginProject } from "./remotePluginProjects.js";

interface Operation {
  peer: string;
  fingerprint: string;
  receipt: PluginManagementReceipt;
  current(): boolean;
  visible(): boolean;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  answer?: (accepted: boolean) => void;
}
export interface RemotePluginManagementDeps {
  list(): InstalledGhost[];
  preferences?: {
    read(
      ...args: Parameters<RemotePluginPreferences["read"]>
    ):
      | ReturnType<RemotePluginPreferences["read"]>
      | Promise<ReturnType<RemotePluginPreferences["read"]>>;
    update: RemotePluginPreferences["update"];
  };
  settingsPage?: true;
  projects?: {
    list(): Promise<Array<PluginManagementProject & { workdir: string }>>;
    resolve?(workdir: string): Promise<RemotePluginProject>;
    disabled(workdir: string): string[];
    setDisabled(
      workdir: string,
      instance: string,
      disabled: boolean,
      assertCurrent: () => void,
    ): void | Promise<void>;
  };
  capture(peer: string): () => boolean;
  captureReceipt(peer: string): () => boolean;
  market: {
    snapshot(): Promise<PluginMarketSnapshot>;
    detail(id: string): Promise<PluginMarketDetail>;
    install(
      id: string,
      options: PluginMarketInstallOptions,
      prompt: GhostInstallConsentPrompt,
      assertCurrent: () => void,
      assertScope: () => void,
    ): Promise<void>;
  };
  setEnabled(
    id: string,
    enabled: boolean,
    approval: string,
    assertCurrent: () => void,
  ): Promise<void>;
  uninstall(
    id: string,
    approval: string,
    assertCurrent: () => void,
  ): Promise<void>;
  installFile?(
    peer: string,
    attachment: string,
    target: string | undefined,
    approval: string | undefined,
    prompt: GhostInstallConsentPrompt,
    /** Owner/peer/cancellation only; the installer binds approval under its lock. */
    assertScope: () => void,
  ): Promise<void>;
}
const invalid = (): never => {
  throw new RemoteResourceRegistryError(
    "INVALID_PARAMS",
    "Invalid plugin management request",
  );
};
const unavailable = (): never => {
  throw new RemoteResourceRegistryError(
    "NOT_FOUND",
    "Plugin management request is no longer available",
  );
};
const str = (v: unknown, max = 256): string =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : invalid();
const approval = (v: unknown): string =>
  isGhostInstallApprovalToken(v) ? (v as string) : invalid();

/** Project display metadata; mutations use Host-owned instance identity, never the displayed path. */
export function projectManagedGhost(g: InstalledGhost): InstalledGhost {
  return {
    manifest: g.manifest,
    dir: g.dir,
    instanceKey: installedGhostStoragePart(g),
    namespace: g.namespace,
    namespaceState: g.namespaceState,
    enabled: g.enabled,
    approval: g.approval,
    trust: g.trust,
    iconDataUrl: g.iconDataUrl,
    builtin: g.builtin,
    retirement: g.retirement,
    taskCapabilityApproved: g.taskCapabilityApproved,
    targetCapabilityApproved: g.targetCapabilityApproved,
    oauthScopeStale: g.oauthScopeStale,
    oauthAuthorizationExpired: g.oauthAuthorizationExpired,
  };
}

/** Per-controller receipts reuse the installer; permission prompts wait outside its lock. */
export class RemotePluginManagement {
  private readonly operations = new Map<string, Operation>();
  // A browsed directory is a transient scope, like the local picker. Do not add a task or recent project.
  private readonly browsedProjects = new Map<
    string,
    { project: RemotePluginProject; current(): boolean }
  >();
  constructor(private readonly deps: RemotePluginManagementDeps) {}
  private find(id: string): InstalledGhost {
    return (
      this.deps.list().find((g) => installedGhostStoragePart(g) === id) ??
      unavailable()
    );
  }
  private operation(peer: string, id: string): Operation {
    const op = this.operations.get(id);
    if (!op || op.peer !== peer || !op.visible()) return unavailable();
    return op;
  }
  private assertScope(op: Operation): void {
    if (!op.current() || op.abort.signal.aborted) return unavailable();
  }
  private async project(
    id: string,
    peer: string,
  ): Promise<RemotePluginProject> {
    const browsed = this.browsedProjects.get(peer);
    if (
      browsed?.project.id === id &&
      browsed.current() &&
      this.deps.projects?.resolve
    ) {
      const resolved = await this.deps.projects.resolve(
        browsed.project.workdir,
      );
      if (!browsed.current() || resolved.id !== id) return unavailable();
      return resolved;
    }
    return (
      (await this.deps.projects?.list())?.find(
        (project) => project.id === id,
      ) ?? unavailable()
    );
  }
  private projectState(
    projectId: string,
    workdir: string,
  ): PluginManagementProjectState {
    const disabled = [...new Set(this.deps.projects!.disabled(workdir))].sort();
    const visible = new Set(this.deps.list().map(installedGhostStoragePart));
    return {
      projectId,
      revision: createHash("sha256")
        .update(JSON.stringify(disabled))
        .digest("hex"),
      disabled: disabled.filter((id) => visible.has(id)),
    };
  }
  private prune(): void {
    for (const [peer, selection] of this.browsedProjects) {
      if (!selection.current()) this.browsedProjects.delete(peer);
    }
    for (const [id, op] of this.operations) {
      if (!op.visible()) {
        op.abort.abort();
        op.answer?.(false);
        clearTimeout(op.timer);
        this.operations.delete(id);
      } else if (
        !op.current() &&
        ["running", "confirmation"].includes(op.receipt.phase)
      ) {
        // A lost connection invalidates further writes, but a reconnect must still
        // be able to query whether the original request actually committed.
        op.abort.abort();
        op.answer?.(false);
      }
    }
  }
  invalidate(): void {
    this.prune();
  }
  async invoke(
    peer: string,
    request: RemoteActionInvokeRequest,
  ): Promise<RemoteActionInvokeResponse> {
    this.prune();
    const input = request.input ?? {};
    const result = (value: unknown): RemoteActionInvokeResponse => ({
      effects: [],
      result: value,
    });
    if (request.actionId === "management:snapshot") {
      if (Object.keys(input).length) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const [market, projects] = await Promise.all([
        this.deps.market.snapshot(),
        this.deps.projects?.list(),
      ]);
      if (!current()) return unavailable();
      const browsed = this.browsedProjects.get(peer)?.project;
      const scopeProjects =
        browsed && projects
          ? [
              browsed,
              ...projects.filter((project) => project.id !== browsed.id),
            ]
          : projects;
      return result({
        version: 1,
        ghosts: this.deps.list().map(projectManagedGhost),
        market,
        ...(this.deps.preferences ? { hostPreferences: true } : {}),
        ...(this.deps.settingsPage ? { settingsPage: true } : {}),
        ...(scopeProjects
          ? {
              projects: scopeProjects.map(({ id, name, path }) => ({
                id,
                name,
                ...(path ? { path } : {}),
              })),
            }
          : {}),
        ...(this.deps.projects?.resolve ? { projectBrowse: true } : {}),
      });
    }
    if (request.actionId === "management:project-select") {
      if (Object.keys(input).some((key) => key !== "path")) return invalid();
      if (!this.deps.projects?.resolve) return unavailable();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const project = await this.deps.projects.resolve(str(input.path, 32768));
      if (!current()) return unavailable();
      this.browsedProjects.set(peer, { project, current });
      return result({ id: project.id, name: project.name, path: project.path });
    }
    if (
      request.actionId === "management:preferences" ||
      request.actionId === "management:preferences-set"
    ) {
      const settings = this.deps.preferences;
      if (
        !settings ||
        !request.resourceRef?.id ||
        Object.keys(input).some(
          (key) =>
            ![
              "expectedInstalledApproval",
              "expectedRevision",
              "kind",
              "patch",
              "visible",
            ].includes(key),
        )
      )
        return invalid();
      const id = str(request.resourceRef.id);
      const expected = approval(input.expectedInstalledApproval);
      const current = this.deps.capture(peer);
      const assertCurrent = () => {
        const ghost = this.find(id);
        if (
          !current() ||
          !ghost.enabled ||
          ghostInstallApprovalToken(ghost.approval) !== expected
        )
          return unavailable();
      };
      assertCurrent();
      const ghost = this.find(id);
      const value =
        request.actionId === "management:preferences"
          ? await settings.read(id, ghost)
          : await settings.update(id, ghost, input, assertCurrent);
      assertCurrent();
      return result(value);
    }
    if (request.actionId === "management:project-state") {
      if (Object.keys(input).some((key) => key !== "projectId"))
        return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const project = await this.project(str(input.projectId), peer);
      if (!current()) return unavailable();
      return result(this.projectState(project.id, project.workdir));
    }
    if (request.actionId === "management:market-detail") {
      if (Object.keys(input).some((k) => k !== "pluginId")) return invalid();
      const current = this.deps.capture(peer);
      if (!current()) return unavailable();
      const detail = await this.deps.market.detail(str(input.pluginId, 1024));
      if (!current()) return unavailable();
      return result(detail);
    }
    if (request.actionId === "management:operation") {
      if (Object.keys(input).some((k) => k !== "operationId")) return invalid();
      return result(this.operation(peer, str(input.operationId)).receipt);
    }
    if (request.actionId === "management:answer") {
      if (
        Object.keys(input).some(
          (k) => !["operationId", "requestId", "confirmed"].includes(k),
        ) ||
        typeof input.confirmed !== "boolean"
      )
        return invalid();
      const op = this.operation(peer, str(input.operationId));
      if (!op.answer || op.receipt.consent?.requestId !== input.requestId)
        return unavailable();
      this.assertScope(op);
      const answer = op.answer;
      delete op.answer;
      delete op.receipt.consent;
      op.receipt.phase = "running";
      answer(input.confirmed);
      return result(op.receipt);
    }
    if (request.actionId === "management:cancel") {
      if (Object.keys(input).some((k) => k !== "operationId")) return invalid();
      const op = this.operation(peer, str(input.operationId));
      // A committed result stays committed; cancellation cannot undo an installation.
      if (
        op.receipt.phase === "running" ||
        op.receipt.phase === "confirmation"
      ) {
        op.abort.abort();
        op.answer?.(false);
      }
      return result(op.receipt);
    }
    if (request.actionId !== "management:begin") return invalid();
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "operationId",
            "kind",
            "pluginId",
            "expectedReleaseId",
            "expectedInstalledApproval",
            "expectedManifest",
            "attachment",
            "projectId",
            "expectedProjectRevision",
          ].includes(k),
      )
    )
      return invalid();
    const id = str(input.operationId, 128);
    const kind = str(input.kind, 32);
    if (
      !["install", "enable", "disable", "uninstall", "install-file"].includes(
        kind,
      )
    )
      return invalid();
    const projectId =
      input.projectId === undefined ? undefined : str(input.projectId);
    const projectRevision =
      input.expectedProjectRevision === undefined
        ? undefined
        : str(input.expectedProjectRevision);
    if (
      projectId
        ? !projectRevision || !["enable", "disable"].includes(kind)
        : projectRevision !== undefined
    )
      return invalid();
    const target = request.resourceRef?.id;
    const fingerprint = JSON.stringify([target ?? null, input]);
    const previous = this.operations.get(id);
    if (previous) {
      if (
        previous.peer !== peer ||
        previous.fingerprint !== fingerprint ||
        !previous.visible()
      )
        return unavailable();
      return result(previous.receipt);
    }
    const installedApproval =
      input.expectedInstalledApproval === undefined
        ? undefined
        : approval(input.expectedInstalledApproval);
    let ghost: InstalledGhost | undefined;
    if (target) {
      ghost = this.find(target);
      if (installedApproval !== ghostInstallApprovalToken(ghost.approval))
        return unavailable();
    } else if (!["install", "install-file"].includes(kind)) return invalid();
    const pluginId = kind === "install" ? str(input.pluginId, 1024) : undefined;
    const releaseId =
      kind === "install" ? str(input.expectedReleaseId, 1024) : undefined;
    if (
      kind === "install-file" &&
      (!this.deps.installFile || typeof input.attachment !== "string")
    )
      return invalid();
    if (
      this.operations.size >= 128 ||
      [...this.operations.values()].filter(
        (op) =>
          op.peer === peer &&
          ["running", "confirmation"].includes(op.receipt.phase),
      ).length >= 8
    )
      return unavailable();
    const current = this.deps.capture(peer);
    if (!current()) return unavailable();
    const op: Operation = {
      peer,
      fingerprint,
      current,
      visible: this.deps.captureReceipt(peer),
      abort: new AbortController(),
      receipt: { operationId: id, phase: "running" },
      timer: setTimeout(() => {
        op.abort.abort();
        op.answer?.(false);
        this.operations.delete(id);
      }, 15 * 60_000),
    };
    op.timer.unref?.();
    this.operations.set(id, op);
    const assertCurrent = () => {
      this.assertScope(op);
      if (
        target &&
        ghostInstallApprovalToken(this.find(target).approval) !==
          installedApproval
      )
        return unavailable();
    };
    const prompt: GhostInstallConsentPrompt = (facts) => {
      assertCurrent();
      const requestId = randomUUID();
      op.receipt = {
        operationId: id,
        phase: "confirmation",
        consent: { ...facts, requestId },
      };
      return new Promise((resolve) => {
        const cancel = () => {
          delete op.answer;
          delete op.receipt.consent;
          resolve(false);
        };
        op.abort.signal.addEventListener("abort", cancel, { once: true });
        op.answer = (accepted) => {
          op.abort.signal.removeEventListener("abort", cancel);
          if (!op.current() || op.abort.signal.aborted) return resolve(false);
          resolve(accepted);
        };
      });
    };
    void (async () => {
      try {
        assertCurrent();
        switch (kind) {
          case "install":
            await this.deps.market.install(
              pluginId!,
              {
                expectedReleaseId: releaseId!,
                allowSourceReplacement: false,
                ...(installedApproval
                  ? { expectedInstalledApproval: installedApproval }
                  : {}),
                ...(input.expectedManifest
                  ? {
                      expectedManifest:
                        input.expectedManifest as PluginMarketDetail["manifest"],
                    }
                  : {}),
              },
              prompt,
              assertCurrent,
              // The installer owns approval checks; this guard survives its directory swap.
              () => this.assertScope(op),
            );
            break;
          case "install-file":
            await this.deps.installFile!(
              peer,
              str(input.attachment, 2048),
              target,
              installedApproval,
              prompt,
              // The native update transaction checks the old approval itself. Its
              // commit hook runs after the directory swap, when that receipt no
              // longer describes the staged package; re-reading it would roll
              // back our own update. Keep owner/peer/cancellation fencing active.
              () => this.assertScope(op),
            );
            break;
          case "enable":
          case "disable":
            if (projectId) {
              const project = await this.project(projectId, peer);
              const assertProjectCurrent = () => {
                assertCurrent();
                if (
                  this.projectState(projectId, project.workdir).revision !==
                  projectRevision
                )
                  return unavailable();
                // Project exceptions can never enable a globally disabled plugin.
                if (kind === "enable" && !this.find(target!).enabled)
                  return unavailable();
              };
              assertProjectCurrent();
              await this.deps.projects!.setDisabled(
                project.workdir,
                target!,
                kind === "disable",
                assertProjectCurrent,
              );
            } else {
              await this.deps.setEnabled(
                target!,
                kind === "enable",
                installedApproval!,
                assertCurrent,
              );
            }
            break;
          case "uninstall":
            await this.deps.uninstall(
              target!,
              installedApproval!,
              assertCurrent,
            );
            break;
        }
        // The authoritative result wins after commit, even if the view was cancelled meanwhile.
        op.receipt = { operationId: id, phase: "succeeded" };
      } catch (error) {
        const code =
          extractIpcError(error)?.code ??
          (error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "INTERNAL");
        op.receipt = {
          operationId: id,
          phase:
            op.abort.signal.aborted ||
            code === "MUTATION_CANCELLED" ||
            code === "SETUP_CANCELLED"
              ? "cancelled"
              : "failed",
          errorCode: code,
        };
      } finally {
        delete op.answer;
      }
    })();
    return result(op.receipt);
  }
}
