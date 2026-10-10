import type { GhostCommandSource } from '@cindy/maker-shared/ghost-command';
import {
  composerDocumentProjectedText,
  normalizeComposerDocument,
  replaceComposerTextRange,
  type ComposerDocument,
} from '@/session/composerDocument';

interface ComposerPluginTrigger {
  from: number;
  query: string;
}

export function detectComposerPluginTrigger(text: string): ComposerPluginTrigger | null {
  const match = /(^|[\s])[$＄¥￥]([^\s]*)$/u.exec(text);
  if (!match || match.index === undefined) return null;
  return { from: match.index + match[1].length, query: match[2] };
}

export function filterComposerPlugins<T extends { enabled?: boolean; manifest: { name: string; command?: string } }>(
  plugins: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  return plugins
    .filter((plugin) => plugin.enabled !== false && !!plugin.manifest.command)
    .filter((plugin) => !normalized || plugin.manifest.name.toLowerCase().includes(normalized)
      || plugin.manifest.command!.toLowerCase().startsWith(normalized));
}

export function appendComposerPluginTrigger(document: ComposerDocument): ComposerDocument {
  const text = composerDocumentProjectedText(document);
  if (detectComposerPluginTrigger(text)) return document;
  return replaceComposerTextRange(document, text.length, text.length, [{
    type: 'text', text: text && !/\s$/u.test(text) ? ' $' : '$',
  }]);
}

export function placeComposerPlugin(
  document: ComposerDocument,
  plugin: GhostCommandSource,
  roster: readonly GhostCommandSource[],
): ComposerDocument {
  if (!plugin.manifest.command || !plugin.enabled) return document;
  let normalized = normalizeComposerDocument(document);
  const text = composerDocumentProjectedText(normalized);
  const trigger = detectComposerPluginTrigger(text);
  if (trigger) {
    const nodes = normalized.nodes.slice();
    let remaining = text.length - trigger.from;
    for (let index = nodes.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const node = nodes[index];
      if (node.type === 'quote') continue;
      if (node.type !== 'text') break;
      const consumed = Math.min(remaining, node.text.length);
      nodes[index] = { ...node, text: node.text.slice(0, node.text.length - consumed) };
      remaining -= consumed;
    }
    if (remaining === 0) normalized = normalizeComposerDocument({ version: 1, nodes });
  }
  let leadingText = '';
  for (const node of normalized.nodes) {
    if (node.type === 'quote' && !leadingText.trim()) continue;
    if (node.type !== 'text') break;
    leadingText += node.text;
  }
  const match = /^\s*[$＄¥￥](\S{1,32})(?=\s|$)/u.exec(leadingText);
  const replace = match && roster.some((entry) =>
    entry.manifest.command?.toLowerCase() === match[1].toLowerCase());
  const end = replace ? match[0].length : 0;
  const nextCharacter = leadingText[end];
  const nodes: ComposerDocument['nodes'] = [{
    type: 'text',
    text: '$' + plugin.manifest.command + (nextCharacter && /\s/u.test(nextCharacter) ? '' : ' '),
  }];
  let remaining = end;
  for (const node of normalized.nodes) {
    if (node.type !== 'text' || remaining === 0) {
      nodes.push(node);
      continue;
    }
    const consumed = Math.min(remaining, node.text.length);
    remaining -= consumed;
    if (consumed < node.text.length) nodes.push({ ...node, text: node.text.slice(consumed) });
  }
  return normalizeComposerDocument({ version: 1, nodes });
}
