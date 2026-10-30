import yaml from 'js-yaml';

const METADATA_KEYS = new Set(['name', 'displayName', 'description', 'updatedAt']);
const BLOCK_SCALAR = /^[>|](?:[+-][1-9]?|[1-9][+-]?)?(?:[ \t]+#.*)?$/;

export function isFrontmatterBlock(value: string): boolean { return BLOCK_SCALAR.test(value.trim()); }

export function unescapeFrontmatterValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** Same metadata semantics for full reads and streamed, byte-bounded previews. */
export function createBotSkillFrontmatterReader(maxFieldBytes = Infinity) {
  const fields = new Map<string, string>();
  let block: { key?: string; header: string; indent: number; parts: string[]; bytes: number } | undefined;
  const finishBlock = () => {
    if (block?.key) {
      try {
        // Parse only an isolated scalar, not arbitrary YAML objects/aliases.
        // js-yaml supplies folding, indentation and chomping semantics.
        const parsed = yaml.load(`value: ${block.header}\n${block.parts.join('')}`) as { value?: unknown };
        fields.set(block.key, typeof parsed?.value === 'string' ? parsed.value : '');
      } catch {
        // Malformed hand-written metadata stays listable, as before.
        fields.set(block.key, block.header);
      }
    }
    block = undefined;
  };
  return {
    line(text: string, truncated = false) {
      const indent = /^ */.exec(text)![0].length;
      if (block) {
        if (!text.trim() || indent > block.indent) {
          if (block.key && block.bytes < maxFieldBytes) {
            const bytes = Buffer.from(text.slice(block.indent) + '\n');
            const retained = bytes.subarray(0, maxFieldBytes - block.bytes);
            block.parts.push(retained.toString('utf8'));
            block.bytes += retained.length;
          }
          return;
        }
        finishBlock();
      }
      const separator = text.indexOf(':');
      if (separator <= 0) return;
      const key = text.slice(0, separator).trim();
      let value = text.slice(separator + 1).trim();
      if (isFrontmatterBlock(value)) {
        // Consume unknown blocks too: their "description:" lines are content.
        block = { ...(METADATA_KEYS.has(key) ? { key } : {}), header: value, indent, parts: [], bytes: 0 };
      } else if (METADATA_KEYS.has(key)) {
        if (truncated && /^["']/.test(value) && !value.endsWith(value[0])) value += value[0];
        fields.set(key, unescapeFrontmatterValue(value));
      }
    },
    finish() { finishBlock(); return fields; },
  };
}
