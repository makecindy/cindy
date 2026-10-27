/** Only public content fields cross the plugin boundary; native metadata never does. */
export function projectHarnessContent(
  role: string,
  content: unknown,
): { content: unknown; truncated?: boolean } {
  let value: unknown;
  if (role === 'user' || role === 'assistant') {
    if (typeof content === 'string') value = content;
    else if (Array.isArray(content)) {
      const text = content.filter((item) => item?.type === 'text' && typeof item.text === 'string');
      value = text.map((item) => ({ type: 'text', text: item.text }));
      if (text.length !== content.length) return { ...bound(value), truncated: true };
    } else if (
      content &&
      typeof content === 'object' &&
      typeof (content as { text?: unknown }).text === 'string'
    ) {
      value = (content as { text: string }).text;
    } else return { content: null, truncated: true };
  } else if (role === 'tool_use' && content && typeof content === 'object') {
    const raw = content as Record<string, unknown>;
    value = { toolName: raw.toolName, input: raw.input };
  } else if (role === 'tool_result' && typeof content === 'string') value = content;
  else return { content: null, truncated: true };
  return bound(value);
}

function bound(value: unknown): { content: unknown; truncated?: boolean } {
  if (typeof value === 'string')
    return value.length > 16_384
      ? { content: value.slice(0, 16_384), truncated: true }
      : { content: value };
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { content: null, truncated: true };
    if (serialized.length > 16_384)
      return { content: serialized.slice(0, 16_384), truncated: true };
    return { content: JSON.parse(serialized) };
  } catch {
    return { content: null, truncated: true };
  }
}
