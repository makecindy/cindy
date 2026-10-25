import { randomUUID } from "node:crypto";
import { parsePeerAttachmentRef } from "@cindy/device-link";
import { MAX_NODE_CINDY_FILE_BYTES } from "@cindy/plugin-runtime/store/ghostManager";
import { ghostInstallApprovalToken } from "@cindy/plugin-runtime/shared/ghost";
import {
  projectPluginWorkdir,
  resolvePluginWorkdir,
} from "@cindy/plugin-runtime/remotePluginProjects";
import type { RemotePluginManagementDeps } from "@cindy/plugin-runtime/remotePluginManagement";
import type { TerminalPlugins } from "./host.js";
import type { TerminalPluginMarket } from "./market.js";
import type { TerminalPluginPreferences } from "./preferences.js";
import type { TerminalMediaTransfer } from "../media-transfer.js";

/** The released GUI contract delegates to the same owner stores and installer
 * used by CLI/TUI. Prompts never hold the installer mutation lock. */
export function pluginManagementDependencies(options: {
  host: TerminalPlugins;
  market: TerminalPluginMarket;
  preferences: TerminalPluginPreferences;
  projects(): Promise<string[]>;
  media?: Pick<TerminalMediaTransfer, "resolve">;
}): Omit<RemotePluginManagementDeps, "capture" | "captureReceipt"> {
  const { host, market, preferences } = options;
  return {
    list: () => host.native.list(),
    settingsPage: true,
    preferences: {
      read: (id, ghost) => host.preferences(id, ghost, preferences),
      update: (id, ghost, input, current) =>
        host.preferences(id, ghost, preferences, input, current),
    },
    projects: {
      list: async () => [
        ...new Map(
          (await options.projects()).map((directory) => {
            const project = projectPluginWorkdir(directory);
            return [project.id, project];
          }),
        ).values(),
      ],
      resolve: resolvePluginWorkdir,
      disabled: (directory) => preferences.disabledIds(directory),
      setDisabled: async (directory, id, disabled, current) => {
        await host.setWorkdirDisabled(preferences, directory, id, disabled, current);
      },
    },
    market: {
      snapshot: () => market.snapshot(),
      detail: (id) => market.detail(id),
      install: (...args) => market.install(...args),
    },
    setEnabled: (id, enabled, approval, current) =>
      host.setEnabled(id, enabled, approval, current),
    uninstall: (id, _approval, current) => host.uninstall(id, current),
    ...(options.media
      ? {
          installFile: (async (
            peer,
            attachment,
            target,
            approval,
            prompt,
            current,
          ) => {
            const reference = parsePeerAttachmentRef(attachment);
            if (!reference || reference.size > MAX_NODE_CINDY_FILE_BYTES)
              throw new Error("INVALID_ATTACHMENT_REFERENCE");
            current();
            const materialized = await options.media!.resolve(attachment, {
              source: "remote",
              deviceId: peer,
              assertCurrent: current,
            });
            const controller = `management-file:${randomUUID()}`;
            let pending: string | undefined;
            try {
              current();
              if (target) {
                const ghost = host.installed(target);
                if (
                  !ghost ||
                  ghostInstallApprovalToken(ghost.approval) !== approval ||
                  ghost.namespace
                )
                  throw new Error("PLUGIN_CHANGED");
              }
              const prepared = await host.prepareInstall(
                materialized.path,
                controller,
                { namespace: null },
              );
              pending = prepared.id;
              current();
              const receiver = host.pendingInstall(
                prepared.id,
                controller,
              ).receiver;
              if (target && (receiver !== target || ghostInstallApprovalToken(host.installed(target)?.approval) !== approval))
                throw new Error("PLUGIN_CHANGED");
              if (
                !(await prompt({
                  facts: prepared.facts,
                  initiator: "user",
                  origin: "local-file",
                  target: prepared.target,
                }))
              )
                throw Object.assign(new Error("MUTATION_CANCELLED"), {
                  code: "MUTATION_CANCELLED",
                });
              current();
              await host.confirmInstall(prepared.id, controller, current);
            } finally {
              if (pending)
                try {
                  host.cancelInstall(pending, controller);
                } catch {
                  /* Consumed by the installer. */
                }
              await materialized.cleanup();
            }
          }) as NonNullable<RemotePluginManagementDeps["installFile"]>,
        }
      : {}),
  };
}
