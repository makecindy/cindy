import type { PluginPageFile } from "@cindy/device-link";

/** Host text resources include UTF-8 parameters; retain the full value for chunk checks. */
export function pluginSettingsMediaType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128 || /[\r\n]/.test(value))
    return undefined;
  const match =
    /^([a-z]+\/[a-z0-9.+-]+)(?:;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.exec(
      value,
    );
  return match?.[1].toLowerCase();
}

/** Validate every chunk against this lease's immutable declaration, including the decoded size. */
export async function readPluginSettingsAsset(
  file: PluginPageFile,
  read: (path: string, offset: number) => Promise<unknown>,
  assertCurrent: () => void,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.size);
  for (let offset = 0; offset < file.size; offset += 48 * 1024) {
    assertCurrent();
    const chunk = (await read(file.path, offset)) as {
      base64?: unknown;
      mime?: unknown;
    };
    assertCurrent();
    const expected = Math.min(48 * 1024, file.size - offset);
    if (
      !chunk ||
      chunk.mime !== file.mime ||
      typeof chunk.base64 !== "string" ||
      chunk.base64.length !== 4 * Math.ceil(expected / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64)
    )
      throw new Error("PLUGIN_SETTINGS_ASSET_INVALID");
    const decoded = atob(chunk.base64);
    if (decoded.length !== expected)
      throw new Error("PLUGIN_SETTINGS_ASSET_INVALID");
    for (let i = 0; i < decoded.length; i++)
      bytes[offset + i] = decoded.charCodeAt(i);
  }
  assertCurrent();
  return bytes;
}
