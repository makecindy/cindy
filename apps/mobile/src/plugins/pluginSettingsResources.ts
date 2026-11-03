import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import native from "../../modules/cindy-html-preview/src/CindyHtmlPreviewModule";
import type { PluginSettingsClient } from "./pluginSettingsClient";
import type { SettingsBootstrapConfig } from "./pluginSettingsBootstrap";
import {
  readPluginSettingsAsset,
  pluginSettingsMediaType,
} from "./pluginSettingsAssets";
import {
  PLUGIN_SETTINGS_CSP,
  prepareSettingsHtml,
  settingsBridgeAsset,
} from "./pluginSettingsHtml";

/** Serve only approved package bytes from an ephemeral, token-protected native loopback origin. */
export async function preparePluginSettingsResources(
  client: PluginSettingsClient,
  theme: SettingsBootstrapConfig["theme"],
  signal: AbortSignal,
) {
  if (!native) throw new Error("PLUGIN_SETTINGS_NATIVE_UNAVAILABLE");
  const server = native;
  const token = Array.from(getRandomBytes(24), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const dir = new Directory(Paths.cache, "html-previews", token);
  let closed = false;
  let closing: Promise<void> | undefined;
  let starting: Promise<string> | undefined;
  const check = () => {
    if (closed || signal.aborted) throw new Error("PLUGIN_SETTINGS_CLOSED");
    client.assertCurrent();
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener("abort", abort);
    closing = (async () => {
      try {
        if (starting) {
          await starting.catch(() => {});
          await server.stop(token);
        }
      } finally {
        if (dir.exists) dir.delete();
      }
    })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    dir.create({ intermediates: true });
    const { document } = client;
    const bridge = settingsBridgeAsset(document, theme);
    const files: string[][] = [];
    // Independent reads share the existing authenticated lease. Bound concurrency to
    // avoid one network round trip per file without flooding the target computer.
    for (let offset = 0; offset < document.files.length; offset += 4) {
      check();
      const batch = await Promise.all(
        document.files
          .slice(offset, offset + 4)
          .map(async (declaration, index) => {
            const mediaType = pluginSettingsMediaType(declaration.mime);
            if (!mediaType) throw new Error("PLUGIN_SETTINGS_ASSET_INVALID");
            const bytes = await readPluginSettingsAsset(
              declaration,
              (path, chunkOffset) =>
                client.send({ kind: "asset", path, offset: chunkOffset }),
              check,
            );
            check();
            const file = new File(dir, String(offset + index));
            file.create();
            if (/^(text\/|application\/(javascript|json))/.test(mediaType)) {
              let text = new TextDecoder("utf-8", { fatal: true })
                .decode(bytes)
                .split("cindy-ghost://" + document.manifestId + "/")
                .join("/");
              if (mediaType === "text/html")
                text = prepareSettingsHtml(text, bridge.path);
              file.write(text);
            } else file.write(bytes);
            // Keep Host MIME for validation; the native server takes a bare media type.
            return [declaration.path, file.name, mediaType];
          }),
      );
      files.push(...batch);
    }
    const script = new File(dir, String(files.length));
    script.create();
    script.write(bridge.text);
    files.push([bridge.path, script.name, "application/javascript"]);
    check();
    starting = server.start(
      decodeURIComponent(dir.uri.replace(/^file:\/\//, "")),
      document.entry,
      token,
      PLUGIN_SETTINGS_CSP,
      files,
    );
    const url = await starting;
    check();
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
