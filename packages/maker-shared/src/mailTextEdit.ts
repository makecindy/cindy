import { parse, serialize, defaultTreeAdapter as adapter, html as htmlNames, type DefaultTreeAdapterTypes } from 'parse5';

type Run = { start: number; end: number; text: string };
type Paragraph = { text: string; runs: Run[] };
const blocks = new Set('p div section article header footer main blockquote pre li ul ol table tr td th h1 h2 h3 h4 h5 h6'.split(' '));
const omitted = new Set('head script style template noscript svg math iframe object textarea select'.split(' '));

/** Source offsets let both clients change text without serializing the document:
 * styles, links, CID references and untouched markup retain their original bytes.
 * No HTML is evaluated and preview URLs never enter the saved draft. */
export function mailTextParagraphs(html: string): Paragraph[] {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const result: Paragraph[] = [];
  let runs: Run[] = [];
  let insertAt = html.length;
  const flush = (force = false) => {
    const text = runs.map(run => run.text).join('');
    if (text.trim() || (force && runs.length)) result.push({ text, runs });
    runs = [];
  };
  const walk = (node: DefaultTreeAdapterTypes.Node) => {
    if ('tagName' in node) {
      if (omitted.has(node.tagName) || node.attrs.some(a => a.name === 'hidden' || (a.name === 'aria-hidden' && a.value === 'true'))) return;
      if (node.tagName === 'body') insertAt = node.sourceCodeLocation?.endTag?.startOffset ?? html.length;
      if (blocks.has(node.tagName)) flush();
      if (node.tagName === 'br' && node.sourceCodeLocation) {
        runs.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset, text: '\n' });
      }
    }
    const count = result.length;
    if ('value' in node && node.sourceCodeLocation && (node.value.trim() || !/[\r\n]/.test(node.value))) {
      runs.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset, text: node.value });
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child);
    if ('tagName' in node && blocks.has(node.tagName)) {
      if (!runs.length && result.length === count && node.sourceCodeLocation?.startTag) {
        const at = node.sourceCodeLocation.startTag.endOffset;
        runs.push({ start: at, end: at, text: '' });
      }
      flush(true);
    }
  };
  walk(doc); flush();
  return result.length ? result : [{ text: '', runs: [{ start: insertAt, end: insertAt, text: '' }] }];
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n?|\n/g, '<br>');

export const mailInlineRuns = (source: string) => mailTextParagraphs(source).flatMap(p => p.runs);

/** Only text from known source spans is accepted, never HTML from the WebView. */
export function applyMailInlineEdits(source: string, edits: Record<string, string>): { html: string; text: string } | null {
  const runs = mailInlineRuns(source);
  const patches: { start: number; end: number; value: string }[] = [];
  for (const [id, text] of Object.entries(edits)) {
    if (!/^(0|[1-9]\d*)$/.test(id) || !runs[Number(id)] || typeof text !== 'string' || text.length > 16000 || text.includes('\0')) return null;
    const run = runs[Number(id)];
    if (text !== run.text) patches.push({ start: run.start, end: run.end, value: escape(text) });
  }
  let html = source;
  for (const p of patches.sort((a, b) => b.start - a.start)) html = html.slice(0, p.start) + p.value + html.slice(p.end);
  const text = mailTextParagraphs(html).map(p => p.text).join('\n\n');
  return html.length <= 64000 && text.length <= 16000 ? { html, text } : null;
}

const tags = new Set('html head body style a b strong i em u s strike p div span br hr blockquote pre code ul ol li h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr td th colgroup col img font sub sup section header footer main article center'.split(' '));
const attrs = new Set('class id href src alt title width height colspan rowspan align valign dir color bgcolor face size cellpadding cellspacing role hidden aria-hidden'.split(' '));
const cleanCss = (value: string) => /expression|\\/i.test(value) ? '' : value.replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none');
export type MailInlineImage = { cid: string; url: string };

/** External mail images are opt-in; relative URLs have no trustworthy base. */
export function externalMailImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Invalid image sources stay blocked. */ }
}

export function hasMailExternalImages(source: string): boolean {
  const visit = (node: DefaultTreeAdapterTypes.Node): boolean => {
    if ('tagName' in node) {
      if (!tags.has(node.tagName) || node.namespaceURI !== htmlNames.NS.HTML) return false;
      if (node.tagName === 'img' && externalMailImageUrl(node.attrs.find(a => a.name === 'src')?.value || '')) return true;
    }
    return 'childNodes' in node && node.childNodes.some(visit);
  };
  return visit(parse(source));
}

/** Sanitize before creating our markers. Mail-provided editing attributes,
 * scripts, nested contexts and event handlers can never become editor controls. */
export function safeMailDocument(source: string, inline = false, images: MailInlineImage[] = [], allowExternalImages = false): string {
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const runs = inline ? mailInlineRuns(source) : [];
  const byStart = new Map(runs.map((run, id) => [run.start, { ...run, id }]));
  const used = new Set<number>();
  const span = (id: number) => {
    used.add(id);
    const el = adapter.createElement('span', htmlNames.NS.HTML, [{ name: 'data-cindy-mail-run', value: String(id) }]);
    adapter.appendChild(el, adapter.createTextNode(runs[id].text));
    return el;
  };
  const visit = (parent: DefaultTreeAdapterTypes.ParentNode) => {
    const children: DefaultTreeAdapterTypes.ChildNode[] = [];
    for (const node of parent.childNodes) {
      if ('tagName' in node) {
        if (!tags.has(node.tagName) || node.namespaceURI !== htmlNames.NS.HTML) continue;
        const externalImage = allowExternalImages && node.tagName === 'img'
          ? externalMailImageUrl(node.attrs.find(a => a.name === 'src')?.value || '') : undefined;
        node.attrs = node.attrs.filter(a => a.name === 'style' || (attrs.has(a.name) &&
          (a.name !== 'href' || /^(https?:|mailto:)/i.test(a.value)) &&
          (a.name !== 'src' || /^(cid:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(a.value))));
        // Inline hosts start opted-in requests after the document is ready, so
        // a slow image server cannot hold the entire mail body invisible.
        if (externalImage) node.attrs.push({ name: inline ? 'data-cindy-mail-external-src' : 'src', value: externalImage }, { name: 'referrerpolicy', value: 'no-referrer' });
        for (const attr of node.attrs) if (attr.name === 'style') attr.value = cleanCss(attr.value);
        if (node.tagName === 'style') {
          node.childNodes = node.childNodes.filter(n => 'value' in n);
          for (const child of node.childNodes) if ('value' in child) child.value = cleanCss(child.value);
        } else visit(node);
        if (node.tagName === 'img') {
          const src = node.attrs.find(a => a.name === 'src');
          const cid = /^cid:(.*)$/.exec(src?.value || '')?.[1];
          if (cid) {
            node.attrs.push({ name: 'data-cindy-mail-cid', value: cid });
            const image = images.find(i => i.cid === cid);
            if (image && validMailImageUrl(image.url)) src!.value = image.url;
          }
        }
      } else if (!('value' in node)) continue;
      const run = byStart.get(node.sourceCodeLocation?.startOffset ?? -1);
      const isText = 'value' in node || ('tagName' in node && node.tagName === 'br');
      if (run && isText) children.push(span(run.id));
      else children.push(node);
    }
    parent.childNodes = children;
    for (const child of children) child.parentNode = parent;
    if ('tagName' in parent) {
      const at = parent.sourceCodeLocation?.startTag?.endOffset;
      const empty = at === undefined ? undefined : byStart.get(at);
      if (empty && empty.start === empty.end && !used.has(empty.id)) adapter.appendChild(parent, span(empty.id));
    }
  };
  visit(doc);
  // Image-only documents and fragments still need somewhere to place a caret.
  const root = doc.childNodes.find(n => 'tagName' in n && n.tagName === 'html') as DefaultTreeAdapterTypes.Element;
  const body = root.childNodes.find(n => 'tagName' in n && n.tagName === 'body') as DefaultTreeAdapterTypes.Element;
  runs.forEach((run, id) => { if (run.start === run.end && !used.has(id)) adapter.appendChild(body, span(id)); });
  return serialize(doc);
}

export const validMailImageUrl = (url: string) => /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/.test(url) || /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(url);
// Intrinsic mail paper, also used by reader chrome so it meets the document
// without the app theme's warm-white tint. Authored body colors still win.
export const MAIL_PAPER_COLOR = 'white';
export const MAIL_INLINE_STYLE = `html{color-scheme:light}body{margin:4px;background:${MAIL_PAPER_COLOR};color:#111;font:16px/1.6 Arial,Helvetica,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}[data-cindy-mail-run]{white-space:pre-wrap;outline:none}[data-cindy-mail-run]:empty{display:inline-block;min-width:1ch;min-height:1em}`;
export function mailInlineDocument(source: string, images: MailInlineImage[] = [], allowExternalImages = false): string {
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src data: cindy-media:' + (allowExternalImages ? ' https: http:' : '') + '; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + MAIL_INLINE_STYLE + '</style>' + safeMailDocument(source, true, images, allowExternalImages);
}

/** Executed only by the native WebView injection API. The document CSP allows
 * no page scripts. The sole bridge message contains a run index and plain text. */
export function mailInlineBindingScript(documentId: number): string {
  return `(function(){
    if(document.documentElement.dataset.cindyMailBound==='1')return;
    document.documentElement.dataset.cindyMailBound='1';
    var composing=false;
    function changed(event){
      if(composing||document.documentElement.dataset.cindyMailEditable!=='1')return;
      var el=event.target.closest('[data-cindy-mail-run]');if(!el)return;
      var text=el.innerText===undefined?el.textContent:el.innerText;
      if(text.length>16000)return;
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'mail-text',documentId:${JSON.stringify(documentId)},id:el.getAttribute('data-cindy-mail-run'),text:text}));
    }
    document.addEventListener('compositionstart',function(){composing=true});
    document.addEventListener('compositionend',function(e){composing=false;changed(e)});
    document.addEventListener('input',changed);
    document.addEventListener('click',function(e){if(e.target.closest('a'))e.preventDefault()});
    document.addEventListener('drop',function(e){e.preventDefault()});
    document.addEventListener('paste',function(e){e.preventDefault();if(document.documentElement.dataset.cindyMailEditable==='1')document.execCommand('insertText',false,e.clipboardData.getData('text/plain'))});
  })();true;`;
}

export function mailInlineRefreshScript(enabled: boolean, images: MailInlineImage[]): string {
  const safeImages = images.filter(i => validMailImageUrl(i.url));
  return `(function(){
    document.documentElement.dataset.cindyMailEditable=${JSON.stringify(enabled ? '1' : '0')};
    document.querySelectorAll('[data-cindy-mail-run]').forEach(function(el){el.contentEditable=${JSON.stringify(enabled ? 'plaintext-only' : 'false')};el.spellcheck=true});
    var images=${JSON.stringify(safeImages)};
    document.querySelectorAll('img[data-cindy-mail-cid]').forEach(function(el){var image=images.find(function(i){return i.cid===el.getAttribute('data-cindy-mail-cid')});if(image)el.src=image.url});
  })();true;`;
}
