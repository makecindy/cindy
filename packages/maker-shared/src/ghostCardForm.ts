import { parse, parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5';

/** Declarative, non-secret text fields. Plugins never supply executable controls. */
export interface GhostCardFormField {
  name: string;
  label: string;
  value: string;
  multiline?: boolean;
  row?: string;
  collapsed?: boolean;
  kind?: "recipients" | "mail-html" | "mail-attachments" | "hidden";
}
export const GHOST_CARD_FORM_MAX_VALUE = 16000;
export const MAIL_HTML_MAX_VALUE = 64000;
export const MAIL_CARD_MAX_BYTES = 1024 * 1024;
export function ghostCardFieldMaxValue(name: string): number {
  return name === 'bodyHtml' || name === 'quoteHtml' ? MAIL_HTML_MAX_VALUE : GHOST_CARD_FORM_MAX_VALUE;
}
export interface MailAttachmentItem { key: string; filename: string; bytes?: number; contentId?: string; mimeType?: string; previewUrl?: string }
export function parseMailAttachmentItems(value: string): MailAttachmentItem[] | null {
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items) || items.length > 100 || items.some(i => !i || typeof i.key !== 'string' || !i.key || i.key.length > 256 || typeof i.filename !== 'string' || i.filename.length > 1024 ||
      (i.bytes !== undefined && (!Number.isSafeInteger(i.bytes) || i.bytes < 0)) || (i.contentId !== undefined && (typeof i.contentId !== 'string' || i.contentId.length > 256))) || new Set(items.map(i => i.key)).size !== items.length) return null;
    return items.map(i => ({ key: i.key, filename: i.filename, ...(i.bytes !== undefined ? { bytes: i.bytes } : {}), ...(i.contentId ? { contentId: i.contentId } : {}),
      ...(typeof i.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(i.mimeType) ? { mimeType: i.mimeType } : {}),
      ...(typeof i.previewUrl === 'string' && /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/.test(i.previewUrl) ? { previewUrl: i.previewUrl } : {}) }));
  } catch { return null; }
}
function usedMailImageCids(values: Record<string, string>): Set<string> {
  const used = new Set<string>();
  const walk = (node: DefaultTreeAdapterTypes.Node) => {
    if ('tagName' in node) {
      if (['head', 'script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'object', 'textarea', 'select'].includes(node.tagName)) return;
      if (node.tagName === 'img') {
        const src = node.attrs.find(attr => attr.name === 'src')?.value;
        if (src?.startsWith('cid:')) used.add(src.slice(4));
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
  };
  for (const name of ['bodyHtml', 'quoteHtml']) if (values[name]) walk(parse(values[name]));
  return used;
}
/** Presentation only: body images keep their MIME parts and preview URLs, but
 * do not also appear as attachments. Removing the reference reveals them again. */
export function visibleMailAttachments(values: Record<string, string>, field = 'attachmentItems'): MailAttachmentItem[] {
  const files = parseMailAttachmentItems(values[field]) || [];
  if (!files.some(file => file.contentId)) return files;
  const used = usedMailImageCids(values);
  return files.filter(file => !file.contentId || !used.has(file.contentId.replace(/^<|>$/g, '')));
}
/** Remove the MIME part and its visible CID image together, preserving the rest
 * of the authored document (including head styles) on both clients. */
export function removeMailAttachment(values: Record<string, string>, field: string, key: string): Record<string, string> {
  const files = parseMailAttachmentItems(values[field]) || [];
  const file = files.find(f => f.key === key);
  const next = { ...values, [field]: JSON.stringify(files.filter(f => f.key !== key)) };
  const cid = file?.contentId?.replace(/^<|>$/g, '');
  if (cid) for (const name of ['bodyHtml', 'quoteHtml']) if (next[name]) {
    next[name] = next[name].replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      return src && (src[1] ?? src[2] ?? src[3]) === 'cid:' + cid ? '' : tag;
    });
  }
  return next;
}
export function canInsertMailImage(values: Record<string, string>, file: MailAttachmentItem): boolean {
  if (typeof values.bodyHtml !== 'string' || !/^image\/(png|jpeg|gif|webp)$/i.test(file.mimeType || '')) return false;
  const cid = file.contentId?.replace(/^<|>$/g, '');
  return !cid || !usedMailImageCids(values).has(cid);
}
/** Reuse an existing MIME part. Only its CID/disposition changes; its bytes
 * remain at the provider. Preview URLs are never written into the HTML. */
export function insertMailImage(values: Record<string, string>, field: string, key: string): Record<string, string> {
  const files = parseMailAttachmentItems(values[field]) || [];
  const file = files.find(f => f.key === key);
  if (!file || !canInsertMailImage(values, file)) return values;
  let cid = file.contentId?.replace(/^<|>$/g, '');
  if (!cid) {
    let n = 1;
    const used = new Set(files.map(f => f.contentId?.replace(/^<|>$/g, '')));
    do { cid = `image-${n++}@cindy.local`; } while (used.has(cid));
  }
  if (!/^[\w.+@-]{1,256}$/.test(cid)) return values;
  const alt = file.filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const image = `<p><img src="cid:${cid}" alt="${alt}" style="max-width:100%;height:auto"></p>`;
  const html = values.bodyHtml;
  const end = /<\/body\s*>/i.exec(html);
  const bodyHtml = end ? html.slice(0, end.index) + image + html.slice(end.index) : html + image;
  const attachmentItems = JSON.stringify(files.map(f => f.key === key ? { ...f, contentId: cid } : f));
  if (bodyHtml.length > MAIL_HTML_MAX_VALUE || attachmentItems.length > GHOST_CARD_FORM_MAX_VALUE) return values;
  return { ...values, bodyHtml, [field]: attachmentItems };
}
export function mailPreviewImages(values: Record<string, string>, images: { cid: string; url: string }[] = []): { cid: string; url: string }[] {
  const result = new Map(images.map(i => [i.cid, i.url]));
  for (const file of parseMailAttachmentItems(values.attachmentItems || '[]') || []) {
    if (file.contentId && file.previewUrl) result.set(file.contentId.replace(/^<|>$/g, ''), file.previewUrl);
  }
  return [...result].map(([cid, url]) => ({ cid, url }));
}
/** Cindy-owned mail presentation, transported inside the existing persisted card.
 * Provider instance + account + draft identify the entity; callId identifies a view. */
export interface MailCardData {
  accountId: string;
  draftId: string;
  key: string;
  from: string;
  fields: GhostCardFormField[];
  /** Last verified provider values, used for three-way merging after restart. */
  baseValues?: Record<string, string>;
  attachments: string[];
  images?: { cid: string; url: string }[];
  state: 'draft' | 'syncing' | 'sending' | 'sent' | 'error' | 'unconfirmed' | 'deleting' | 'deleted';
  status: string;
  sendLabel: string;
  fromLabel: string;
  continueLabel?: string;
  deleteLabel?: string;
  supersededBy?: string;
  pendingSend?: { deadline: number; label: string; cancelLabel: string; sendNowLabel: string };
}
export function parseMailCard(value: unknown): MailCardData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const fields = parseGhostCardForm(p.fields);
  if (!fields || !['to', 'cc', 'bcc', 'subject', 'body'].every(n => fields.some(f => f.name === n))) return null;
  const baseValues = p.baseValues === undefined ? undefined : parseGhostCardFormValues(p.baseValues);
  if (baseValues === null || (baseValues && (!['to', 'cc', 'bcc', 'subject', 'body'].every(n => n in baseValues) ||
      (baseValues.attachmentItems !== undefined && !parseMailAttachmentItems(baseValues.attachmentItems))))) return null;
  for (const k of ['accountId', 'draftId', 'key', 'from', 'status', 'sendLabel', 'fromLabel']) {
    if (typeof p[k] !== 'string' || (p[k] as string).length > 2048) return null;
  }
  if (!p.accountId || !p.draftId || !/^[a-f0-9-]{36}$/.test(p.key as string) ||
      !['draft', 'syncing', 'sending', 'sent', 'error', 'unconfirmed', 'deleting', 'deleted'].includes(p.state as string) ||
      !Array.isArray(p.attachments) || p.attachments.length > 100 ||
      p.attachments.some(a => typeof a !== 'string' || a.length > 1024) ||
      (p.continueLabel !== undefined && (typeof p.continueLabel !== 'string' || p.continueLabel.length > 128)) ||
      (p.deleteLabel !== undefined && (typeof p.deleteLabel !== 'string' || p.deleteLabel.length > 128)) ||
      (p.supersededBy !== undefined && (typeof p.supersededBy !== 'string' || p.supersededBy.length > 128))) return null;
  const pending = p.pendingSend as MailCardData['pendingSend'];
  const images = p.images as MailCardData['images'];
  if (images !== undefined && (!Array.isArray(images) || images.length > 100 || images.some(i => !i || typeof i.cid !== 'string' || i.cid.length > 256 || typeof i.url !== 'string' || !/^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/.test(i.url)))) return null;
  if (pending !== undefined && (!pending || p.state !== 'sending' ||
      !Number.isSafeInteger(pending.deadline) || pending.deadline <= 0 ||
      [pending.label, pending.cancelLabel, pending.sendNowLabel].some(v => typeof v !== 'string' || !v || v.length > 128))) return null;
  return { accountId: p.accountId as string, draftId: p.draftId as string, key: p.key as string,
    from: p.from as string, fields, attachments: p.attachments as string[], state: p.state as MailCardData['state'],
    ...(baseValues ? { baseValues } : {}),
    status: p.status as string, sendLabel: p.sendLabel as string, fromLabel: p.fromLabel as string,
    ...(images ? { images: images.map(i => ({ cid: i.cid, url: i.url })) } : {}),
    ...(p.continueLabel ? { continueLabel: p.continueLabel as string } : {}),
    ...(p.deleteLabel ? { deleteLabel: p.deleteLabel as string } : {}),
    ...(pending ? { pendingSend: { deadline: pending.deadline, label: pending.label, cancelLabel: pending.cancelLabel, sendNowLabel: pending.sendNowLabel } } : {}),
    ...(p.supersededBy ? { supersededBy: p.supersededBy as string } : {}) };
}
export function mailCardStatus(mail: MailCardData, now = Date.now()): string {
  return mail.pendingSend
    ? mail.pendingSend.label.replace('{seconds}', String(Math.max(0, Math.ceil((mail.pendingSend.deadline - now) / 1000))))
    : mail.status;
}
/** Remaining portion of the host's ten-second send grace period. */
export function mailSendRemainingFraction(mail: MailCardData, now = Date.now()): number {
  return mail.pendingSend ? Math.max(0, Math.min(1, (mail.pendingSend.deadline - now) / 10000)) : 0;
}
export function readMailCard(html: string): MailCardData | null {
  const value = /<div\b[^>]*\sdata-cindy-mail="([^"]*)"/.exec(html)?.[1];
  if (!value) return null;
  try { return parseMailCard(JSON.parse(value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))); }
  catch { return null; }
}
export function isLegacyMailCard(html: string): boolean {
  return !readMailCard(html) && !!readGhostCardFormChange(html)?.startsWith('mail:change:');
}
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** Adopt remote changes only where this editor has no newer local change. */
export function mergeGhostCardFormValues(
  local: Record<string, string>,
  base: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([name, value]) => [
      name,
      local[name] === base[name] ? value : (local[name] ?? value),
    ]),
  );
}
// Only delivery promises, never form text. A chat send must not overtake local
// editor events still travelling to the Host (especially over device-link).
const deliveries = new Map<string, Map<string, Promise<boolean>>>();
export function trackGhostCardFormDelivery(
  scope: string,
  key: string,
  delivery: Promise<boolean>,
): void {
  let entries = deliveries.get(scope);
  if (!entries) deliveries.set(scope, (entries = new Map()));
  const settled = delivery.catch(() => false);
  entries.set(key, settled);
  void settled.then((ok) => {
    if (ok && entries!.get(key) === settled) entries!.delete(key);
    if (!entries!.size && deliveries.get(scope) === entries) deliveries.delete(scope);
  });
}
/** Retire an editor's failed barrier without letting chat overtake an in-flight edit. */
export function releaseGhostCardFormDelivery(scope: string, key: string): void {
  const entries = deliveries.get(scope);
  const delivery = entries?.get(key);
  if (!delivery) return;
  void delivery.then(() => {
    if (entries!.get(key) === delivery) entries!.delete(key);
    if (!entries!.size && deliveries.get(scope) === entries) deliveries.delete(scope);
  });
}
export function pendingGhostCardFormDelivery(
  scope: string,
): Promise<boolean> | undefined {
  const entries = deliveries.get(scope);
  if (!entries?.size) return undefined;
  const snapshot = [...entries.values()];
  return Promise.all(snapshot).then(async (results) => {
    if (results.some((ok) => !ok)) return false;
    return (await pendingGhostCardFormDelivery(scope)) ?? true;
  });
}
export function parseGhostCardForm(
  value: unknown,
): GhostCardFormField[] | null {
  let fields = value;
  if (typeof fields === "string") {
    if (fields.length > 200000) return null;
    try {
      fields = JSON.parse(fields);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(fields) || !fields.length || fields.length > 16)
    return null;
  const names = new Set<string>();
  const result: GhostCardFormField[] = [];
  for (const item of fields) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.name !== "string" ||
      !NAME.test(item.name) ||
      ["__proto__", "constructor", "prototype"].includes(item.name) ||
      names.has(item.name) ||
      typeof item.label !== "string" ||
      !item.label ||
      item.label.length > 128 ||
      typeof item.value !== "string" ||
      item.value.length > ghostCardFieldMaxValue(item.name) ||
      (item.multiline !== undefined && typeof item.multiline !== "boolean") ||
      (item.collapsed !== undefined && typeof item.collapsed !== "boolean") ||
      (item.row !== undefined &&
        (typeof item.row !== "string" || !NAME.test(item.row)))
    )
      return null;
    names.add(item.name);
    if (item.kind === 'mail-attachments' && !parseMailAttachmentItems(item.value)) return null;
    result.push({
      name: item.name,
      label: item.label,
      value: item.value,
      ...(item.multiline ? { multiline: true } : {}),
      ...(item.row ? { row: item.row } : {}),
      ...(item.collapsed ? { collapsed: true } : {}),
      ...(['recipients', 'mail-html', 'mail-attachments', 'hidden'].includes(item.kind) ? { kind: item.kind as GhostCardFormField['kind'] } : {}),
    });
  }
  return result;
}

/** Display parsing only: preserve the original header string for editing/sending. */
export function ghostCardRecipients(
  value: string,
): { address: string; label: string }[] {
  const parts: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false,
    angle = 0,
    comment = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && (quoted || comment)) {
      escaped = true;
      continue;
    }
    if (char === '"' && !comment) quoted = !quoted;
    if (quoted) continue;
    if (char === "(") comment++;
    if (char === ")") comment = Math.max(0, comment - 1);
    if (comment) continue;
    if (char === "<") angle++;
    if (char === ">") angle = Math.max(0, angle - 1);
    if ((char === "," || char === ";") && !angle) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((address) => ({
      address,
      label: (/^(.+)\s*<[^<>]+>$/.exec(address)?.[1]?.trim() || address)
        .replace(/^"(.*)"$/, "$1")
        .replace(/\\(["\\])/g, "$1"),
    }));
}

/** Both clients measure their own typography; only the packing decision is shared. */
export function fitGhostCardRecipients(
  available: number,
  groups: { label: number; chips: number[]; more: number[] }[],
  gap = 4,
): number[] {
  const counts = groups.map((group) => group.chips.length);
  const width = (index: number, count: number) => {
    const group = groups[index],
      remaining = group.chips.length - count;
    return (
      group.label +
      gap +
      group.chips.slice(0, count).reduce((a, b) => a + b + gap, 0) +
      (remaining || !group.chips.length ? group.more[remaining] : -gap)
    );
  };
  const total = () =>
    counts.reduce((sum, count, i) => sum + width(i, count), 0);
  while (total() > available) {
    let candidate = -1;
    const hasExtraNames = counts.some((count) => count > 1);
    counts.forEach((count, i) => {
      if (
        count > (hasExtraNames ? 1 : 0) &&
        (candidate < 0 ||
          !hasExtraNames ||
          width(i, count) > width(candidate, counts[candidate]))
      )
        candidate = i;
    });
    // Keep one name per group first, then preserve earlier fields (To before Cc).
    if (candidate < 0) break;
    counts[candidate]--;
  }
  // A shorter name may fit even when the wider group's next name does not.
  for (let i = 0; i < groups.length; i++) {
    while (counts[i] < groups[i].chips.length) {
      counts[i]++;
      if (total() > available) {
        counts[i]--;
        break;
      }
    }
  }
  return counts;
}

/** A stable change action also identifies the editing session across autosave updates. */
export function readGhostCardFormChange(html: string): string | undefined {
  const match = /<div\b[^>]*\sdata-ghost-change="([a-zA-Z0-9_:-]{1,128})"/.exec(
    html,
  );
  return readGhostCardForm(html) && match ? match[1] : undefined;
}
export function parseGhostCardFormValues(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) return null;
  if (
    entries.some(
      ([name, text]) =>
        !NAME.test(name) ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        typeof text !== "string" ||
        text.length > ghostCardFieldMaxValue(name),
    )
  )
    return null;
  if (JSON.stringify(value).length > 200000) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Sanitized HTML attributes only; text is never interpreted as markup. */
export function readGhostCardForm(html: string): GhostCardFormField[] | null {
  const matches = [...html.matchAll(/<div\b[^>]*\sdata-ghost-form="([^"]*)"/g)];
  if (matches.length !== 1) return null;
  return parseGhostCardForm(
    matches[0][1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
}

/** Omit the legacy preview only when a client will render the native fields. */
export function omitGhostCardFormPreview(html: string): string {
  if (!readGhostCardForm(html)) return html;
  // Remove nodes, never source substrings: deletion must not join malformed
  // markup into a new executable tag. Serialization escapes remaining text.
  const doc = parseFragment(html);
  let removed = false;
  const visit = (parent: DefaultTreeAdapterTypes.ParentNode) => {
    parent.childNodes = parent.childNodes.filter(node => {
      if ('tagName' in node) {
        const form = node.tagName === 'div' && node.attrs.find(a => a.name === 'data-ghost-form');
        if (form && parseGhostCardForm(form.value)) { removed = true; return false; }
        if (node.tagName === 'style' || node.tagName === 'script') return false;
      }
      if ('childNodes' in node) visit(node);
      return true;
    });
  };
  visit(doc);
  return removed ? serialize(doc) : html;
}
