/**
 * /harnesses/open-settings: a plugin page asks Cindy to show one of the plugin's own task engines in
 * Settings → Model Providers, where the user manages its accounts, usage and models.
 *
 * Same shape as /harnesses: free of Electron, called from the cindy-ghost:// handler. It only navigates:
 * nothing is changed and nothing is read back. A page can name only an engine its own manifest
 * declares, and only right after a click or key press that Cindy itself saw in that page.
 */
import type { GhostHarnessDecl } from '@cindy/plugin-protocol';

/** Longest accepted body: `{"id":"<engine id of at most 32 characters>"}` with room for whitespace. */
const MAX_BODY_LENGTH = 256;

const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });

export async function handleGhostEngineSettingsRequest(args: {
  method: string;
  readBodyText: () => Promise<string>;
  isCurrent: () => boolean;
  /** Null when the plugin is not installed; undefined when the manifest declares no harnesses. */
  declared: () => readonly GhostHarnessDecl[] | undefined | null;
  /** One-shot: true only when Cindy saw a click or key press in this plugin's page just now. */
  consumeUserGesture: () => boolean;
  /** Shows the engine in Settings → Model Providers; false when no window can show it. */
  open: (harnessId: string) => boolean;
}): Promise<{ status: number; body?: string }> {
  if (!args.isCurrent()) return { status: 403 };
  const declared = args.declared();
  if (declared === null) return { status: 404 };
  if (args.method !== 'POST') return { status: 405 };
  if (!declared?.length) return json(403, { error: 'Declare "harnesses" in ghost.json before opening engine settings' });
  let raw: unknown;
  try {
    const text = await args.readBodyText();
    if (text.length > MAX_BODY_LENGTH) return json(400, { error: 'Body is too long' });
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }
  if (!args.isCurrent()) return { status: 403 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => key !== 'id')) {
    return json(400, { error: 'Body must be {"id":"<engine id>"}' });
  }
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== 'string') return json(400, { error: 'Body must be {"id":"<engine id>"}' });
  // Only the plugin's own declared engines: the page never chooses another plugin's or a built-in provider.
  if (!declared.some((harness) => harness.id === id)) return json(403, { error: 'Engine is not declared in ghost.json' });
  // Checked last so a malformed request does not use up the user's click.
  if (!args.consumeUserGesture()) return json(403, { error: 'Call this from a click or key press in the page' });
  if (!args.open(id)) return json(503, { error: 'No window can show the settings right now' });
  return json(200, { ok: true });
}
