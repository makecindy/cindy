import { goBackGuarded } from "@/utils/backGuard";
import { useState } from "react";
import { Alert, Platform } from "react-native";
import { Redirect, useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { MOBILE_VISUAL_MOCK_ENABLED } from "@/config/env";
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from "@/platform/chrome/SimpleStackHeader";
import { PluginDetailView } from "@/plugins/PluginDetailView";
import { PluginManagementMenu } from "@/plugins/PluginManagementMenu";
import { PluginSettingsCard } from "@/plugins/PluginSettingsCard";
import { useTheme } from "@/theme";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";
import type { PluginDetailModel } from "@/plugins/pluginDetailModel";
import type { PluginSettingsClientOptions } from "@/plugins/pluginSettingsClient";
import { PluginNoticePreview } from "@/debug/PluginNoticePreview";
import assets from "@/debug/pluginSettingsPreviewAssets.json";

// Isolated native visual fixture. No real Host, plugin installation, credentials or authorization.
export default function PluginManagementPreview() {
  const { scenario } = useLocalSearchParams<{ scenario?: string }>();
  const [options] = useState(createSettingsFixture);
  const demosEnabled = typeof __DEV__ !== "undefined" && __DEV__ && process.env.EXPO_PUBLIC_CINDY_PLUGIN_DEMOS === "1";
  if (!MOBILE_VISUAL_MOCK_ENABLED && !demosEnabled) return <Redirect href="/" />;
  if (scenario && !demosEnabled) return <Redirect href="/" />;
  return scenario ? <PluginNoticePreview scenario={scenario} settingsOptions={options} /> : <Preview />;
}
function Preview() {
  const { colors } = useTheme(),
    router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [notice, setNotice] = useState(
    "QA preview · Synthetic Host · No real account",
  );
  const [options] = useState(createSettingsFixture);
  const row: HostedRemoteCollectionItem = {
    key: "qa-settings",
    host: { deviceId: "qa-host", deviceName: "QA Mac" },
    item: {
      ref: { collectionId: "plugins", kind: "plugin", id: "qa-settings" },
      revision: "1",
      display: {
        title: "Settings Playground",
        subtitle: "Original plugin settings on your computer",
      },
      actions: [],
      links: [],
    },
  };
  const model: PluginDetailModel = {
    version: "1.0.0",
    details: [{ key: "author", title: "Author", value: "QA plugin author" }],
    description: "Edit your plugin’s original settings, then use it in a task.",
    taskUsable: true,
    canUseTasks: enabled,
    canToggle: true,
    hasSettings: true,
    taskPreferences: false,
    mobileSettings: false,
    builtin: false,
    missing: [],
    expired: [],
    setupGroups: [],
    permissions: [
      {
        kind: "network",
        labelKey: "networkHost",
        title: "Network access",
        description: "Connect to the service you configure.",
      },
      {
        kind: "network",
        labelKey: "networkSecret",
        title: "Account credentials",
        description: "Stored on the selected computer.",
      },
    ],
    tools: [
      {
        name: "Search documents",
        description: "Search the configured workspace.",
      },
    ],
  };
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={{ flex: 1, backgroundColor: colors.surface }}
    >
      <SimpleStackHeader
        title="Settings Playground"
        onBack={() => goBackGuarded(router)}
        rightToolbar={
          Platform.OS === "ios" ? (
            <PluginManagementMenu
              nativeToolbar
              actions={[
                { id: "update", title: "Update · 2.0.0" },
                { id: "uninstall", title: "Uninstall", destructive: true },
              ]}
              onAction={(action) =>
                Alert.alert(
                  "QA only",
                  action === "update"
                    ? "Update selected"
                    : "Uninstall selected",
                )
              }
            />
          ) : undefined
        }
        right={
          Platform.OS === "ios" ? undefined : (
            <PluginManagementMenu
              actions={[
                { id: "update", title: "Update · 2.0.0" },
                { id: "uninstall", title: "Uninstall", destructive: true },
              ]}
              onAction={(action) =>
                Alert.alert(
                  "QA only",
                  action === "update"
                    ? "Update selected"
                    : "Uninstall selected",
                )
              }
            />
          )
        }
      />
      <PluginDetailView
        row={row}
        enabled={enabled}
        busy={false}
        online
        model={model}
        settingsOpen={false}
        onEnabledChange={setEnabled}
        onOpen={() => {}}
        onResolveStatus={() => {}}
        onNewTask={() => Alert.alert("QA only", "New task selected")}
        onChooseTask={() => Alert.alert("QA only", "Existing task selected")}
        previewLabel={notice}
        settingsContent={
          <PluginSettingsCard
            {...options}
            active
            generation="qa"
            onNotice={setNotice}
            onLoading={(loading) =>
              setNotice(
                loading ? "QA settings loading" : "QA settings resources ready",
              )
            }
            onError={(error) => setNotice("QA: " + error.message)}
            onConfirm={async () => false}
            onDirectory={async () => null}
          />
        }
      />
    </SafeAreaView>
  );
}
function createSettingsFixture(): PluginSettingsClientOptions {
  let preferences = {
    displayLabel: "QA Mac",
    notifications: true,
    language: "en",
    lastField: "Long form field",
  };
  let saved = false;
  let documentEpoch = 0;
  let accounts = [
    { id: "one", label: "Test account one", isDefault: true },
    { id: "two", label: "Test account two", isDefault: false },
  ];
  const files = Object.entries(assets).map(([path, text]) => ({
    path,
    size: new TextEncoder().encode(text).length,
    mime: path.endsWith("html") ? "text/html" : "application/javascript",
  }));
  const document = {
    pageId: "qa-page",
    documentIsolation: true,
    pluginId: "qa-settings",
    manifestId: "qa-settings",
    name: "QA settings",
    entry: "settings.html",
    files,
  };
  return {
    identity: {
      deviceId: "qa-host",
      instanceId: "qa-settings",
      expectedInstalledApproval: "legacy-unapproved",
    },
    assertCurrent() {},
    invokeTarget: async () => ({ result: document }),
    openSession: async () => ({
      dispose() {},
      request: async (raw) => {
        if (raw.op !== "settings") throw new Error("QA_ONLY");
        const c = raw.command;
        if (c.kind === "document") { documentEpoch = c.epoch; return {}; }
        if (c.kind === "asset") {
          const text = assets[c.path as keyof typeof assets];
          const bytes = new TextEncoder()
            .encode(text)
            .slice(c.offset, c.offset + 48 * 1024);
          return {
            base64: btoa(
              Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
            ),
            mime: files.find((file) => file.path === c.path)!.mime,
          };
        }
        if (c.kind === "poll")
          return {
            events: [],
            confirms: [],
            notifications: [],
            directories: [],
          };
        if (c.kind !== "fetch") return {};
        let body: unknown;
        if (c.path === "/kv") {
          if (c.method === "PUT") preferences = JSON.parse(c.body ?? "{}");
          body = { ...preferences, documentEpoch };
        } else if (c.path === "/secrets/key" && c.method === "PUT") {
          saved = true;
          return { status: 204, mime: "application/json", base64: "" };
        } else if (c.path === "/secrets") body = [{ key: "key", saved }];
        else if (c.path === "/oauth/login/default") {
          const id = JSON.parse(c.body ?? "{}").accountId;
          accounts = accounts.map((account) => ({
            ...account,
            isDefault: account.id === id,
          }));
          body = { ok: true };
        } else if (c.path === "/oauth") body = [{ key: "login", accounts }];
        else return { status: 400, mime: "application/json", base64: "e30=" };
        return {
          status: 200,
          mime: "application/json",
          base64: btoa(
            String.fromCharCode(
              ...new TextEncoder().encode(JSON.stringify(body)),
            ),
          ),
        };
      },
    }),
  };
}
