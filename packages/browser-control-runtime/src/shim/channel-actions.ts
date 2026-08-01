/**
 * Shim: openclaw/plugin-sdk/channel-actions.
 *
 * These build agent-tool JSON Schema / result envelopes for the UPSTREAM
 * browser tool (browser-tool.schema.ts), which we do NOT vendor — Cindy
 * exposes its own MCP tool in @cindy/mcps. They are only re-exported by the
 * dropped `sdk-setup-tools` bridge and never called on the dispatcher path.
 * `stringEnum`/`optionalStringEnum` keep a typebox-compatible shape in case a
 * future caller needs them.
 */
import { Type } from 'typebox';

export function stringEnum<T extends readonly string[]>(values: T) {
  return Type.Unsafe<T[number]>({ type: 'string', enum: [...values] });
}

export function optionalStringEnum<T extends readonly string[]>(values: T) {
  return Type.Optional(stringEnum(values));
}

export function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function imageResultFromFile(_path: string): never {
  throw new Error('channel-actions.imageResultFromFile is not used in the in-process runtime');
}

export function readStringParam(input: Record<string, unknown>, key: string): string | undefined {
  const v = input?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function readPositiveIntegerParam(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = input?.[key];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}
