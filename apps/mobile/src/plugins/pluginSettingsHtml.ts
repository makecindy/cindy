import type { PluginSettingsDocument } from "./pluginSettingsClient";
import type { SettingsBootstrapConfig } from "./pluginSettingsBootstrap";
import { PLUGIN_SETTINGS_BOOTSTRAP } from "./pluginSettingsBootstrap.generated";

/** Desktop settings CSP plus frame/form/navigation isolation; scripts retain their original layout. */
export const PLUGIN_SETTINGS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function settingsBridgeAsset(
  document: PluginSettingsDocument,
  theme: SettingsBootstrapConfig["theme"],
) {
  let path = "__cindy_settings_bridge.js";
  while (document.files.some((file) => file.path === path)) path = "_" + path;
  const config: SettingsBootstrapConfig = {
    pageId: document.pageId,
    manifestId: document.manifestId,
    files: document.files.map((file) => file.path),
    theme,
  };
  return {
    path,
    text:
      PLUGIN_SETTINGS_BOOTSTRAP +
      "\nsettingsBootstrap(" +
      JSON.stringify(config).replace(/</g, "\\u003c") +
      ");",
  };
}

/** Only package bytes are rewritten/persisted. Configuration and responses never enter this file. */
export function prepareSettingsHtml(html: string, bridgePath: string): string {
  const script = '<script src="/' + bridgePath + '"></script>';
  // Same host defaults as Desktop's original settings surface; author styles remain intact.
  const defaults =
    '<style>body{margin:0;background:var(--settings-theme-card-bg,var(--surface));color:var(--text-primary);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}input::placeholder,textarea::placeholder{color:var(--text-placeholder);opacity:1}</style>';
  const viewport = /<meta\s[^>]*name\s*=\s*["']?viewport\b/i.test(html)
    ? ""
    : '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
  const injection = script + defaults + viewport;
  // Head-first injection executes before the original settings scripts, including ES modules.
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + injection)
    : injection + html;
}

export function settingsInjection(
  method: "__cindySettingsReceive" | "__cindySettingsTheme",
  value: unknown,
): string {
  const encoded = JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return "window." + method + "?.(" + encoded + ");true;";
}
