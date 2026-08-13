/** Self-contained HTML runtime for the mobile inline-atom composer WebView. */
import type { ComposerDocument } from '@/session/composerDocument';
import {
  MAX_PASTED_IMAGE_BASE64_CHARS,
  MAX_PASTED_IMAGE_COUNT,
  MAX_PASTED_IMAGE_NAME_CHARS,
  SUPPORTED_PASTED_IMAGE_MIME_TYPES,
} from '@/session/composerRichInputProtocol';
import {
  COMPOSER_SINGLE_LINE_HEIGHT,
  COMPOSER_TEXT_FONT_SIZE,
  COMPOSER_TEXT_HORIZONTAL_PADDING,
  COMPOSER_TEXT_LINE_HEIGHT,
  composerTextPaddingForPlatform,
  type ComposerTextPlatform,
} from '@/session/composerTextMetrics';

export interface ComposerRichInputTheme {
  background: string;
  border: string;
  chip: string;
  focus: string;
  placeholder: string;
  text: string;
  textSecondary: string;
}

export interface ComposerRichInputConfig {
  accessibilityLabel: string;
  document: ComposerDocument;
  editable: boolean;
  maxHeight: number;
  opticalPadding?: boolean;
  placeholder: string;
  platform?: ComposerTextPlatform;
  theme: ComposerRichInputTheme;
}

/**
 * The editor intentionally has no network dependencies. Native owns the
 * semantic document; this page owns IME/selection and reports normalized DOM
 * changes after composition commits.
 */
export function buildComposerRichInputHtml(config: ComposerRichInputConfig): string {
  const bootstrap = JSON.stringify(config).replace(/</g, '\\u003c');
  const composerTextPadding = composerTextPaddingForPlatform(config.platform ?? 'ios', {
    optical: config.opticalPadding !== false,
  });
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  /* 字号 / 行高 / 内边距来自 composerTextMetrics(与原生输入框、语音听写覆盖层同源):
     任一处漂移都会让同一段文字在两个渲染器里换行位置不同,听写时新起的行被裁在框外。 */
  #editor {
    color: var(--text); caret-color: var(--focus);
    font-size: ${COMPOSER_TEXT_FONT_SIZE}px; line-height: ${COMPOSER_TEXT_LINE_HEIGHT}px;
    min-height: ${COMPOSER_SINGLE_LINE_HEIGHT}px; max-height: var(--max-height);
    overflow-y: auto; outline: none;
    padding: ${composerTextPadding.top}px ${COMPOSER_TEXT_HORIZONTAL_PADDING}px ${composerTextPadding.bottom}px;
    white-space: pre-wrap; overflow-wrap: anywhere; -webkit-user-select: text;
  }
  #editor:empty::before { content: attr(data-placeholder); color: var(--placeholder); pointer-events: none; }
  .atom {
    display: inline-flex; align-items: center; max-width: min(240px, 72vw);
    position: relative; top: -1px; margin: 0 2px; padding: 2px 8px;
    vertical-align: middle; border: 1px solid var(--border);
    border-radius: 9999px; background: var(--chip); color: var(--text); font-size: 12px;
    line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    -webkit-touch-callout: none; -webkit-user-select: none; user-select: none;
  }
  .atom::before { content: attr(data-icon); margin-right: 6px; color: var(--secondary); }
  .slash {
    color: var(--text); background: var(--chip); border: 1px solid var(--border);
    border-radius: 9999px; margin: 0 2px; padding: 2px 8px; font: inherit;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style></head><body>
<div id="editor" role="textbox" aria-multiline="true" spellcheck="true"></div>
<script>
(() => {
  let config = ${bootstrap};
  const root = document.getElementById('editor');
  const style = document.documentElement.style;
  const applyConfig = (next) => {
    config = Object.assign({}, config, next, { theme: Object.assign({}, config.theme, next.theme || {}) });
    style.setProperty('--text', config.theme.text);
    style.setProperty('--secondary', config.theme.textSecondary);
    style.setProperty('--placeholder', config.theme.placeholder);
    style.setProperty('--chip', config.theme.chip);
    style.setProperty('--border', config.theme.border);
    style.setProperty('--focus', config.theme.focus);
    style.setProperty('--max-height', config.maxHeight + 'px');
    const padding = ${JSON.stringify({
      ios: {
        optical: composerTextPaddingForPlatform('ios'),
        geometric: composerTextPaddingForPlatform('ios', { optical: false }),
      },
      android: {
        optical: composerTextPaddingForPlatform('android'),
        geometric: composerTextPaddingForPlatform('android', { optical: false }),
      },
      default: {
        optical: composerTextPaddingForPlatform('default'),
        geometric: composerTextPaddingForPlatform('default', { optical: false }),
      },
    })}[(config.platform || 'ios')][config.opticalPadding === false ? 'geometric' : 'optical'];
    root.style.paddingTop = padding.top + 'px';
    root.style.paddingBottom = padding.bottom + 'px';
    root.dataset.placeholder = config.placeholder;
    root.setAttribute('aria-label', config.accessibilityLabel);
    root.contentEditable = config.editable ? 'true' : 'false';
  };
  applyConfig(config);

  let applying = false;
  let composing = false;
  let lastSignature = '';
  let pasteRequestSequence = 0;
  const pasteMarkers = new Map();
  const CARET_ANCHOR = '\\u200B';
  const MAX_PASTED_IMAGE_BASE64_CHARS = ${MAX_PASTED_IMAGE_BASE64_CHARS};
  const MAX_PASTED_IMAGE_COUNT = ${MAX_PASTED_IMAGE_COUNT};
  const MAX_PASTED_IMAGE_NAME_CHARS = ${MAX_PASTED_IMAGE_NAME_CHARS};
  const SUPPORTED_PASTED_IMAGE_MIME_TYPES = new Set(${JSON.stringify(SUPPORTED_PASTED_IMAGE_MIME_TYPES)});

  const post = (payload) => {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  };
  const isCaretAnchor = (node) =>
    Boolean(node && node.nodeType === Node.TEXT_NODE && String(node.nodeValue || '').startsWith(CARET_ANCHOR));
  const isEmptyCaretAnchor = (node) => isCaretAnchor(node) && node.nodeValue === CARET_ANCHOR;
  const makeCaretAnchor = () => document.createTextNode(CARET_ANCHOR);
  const atomLabel = (node) => {
    if (node.type === 'quote') return String(node.quote && node.quote.text || '').replace(/\\s+/g, ' ').trim();
    if (node.type === 'mention' || node.type === 'session-link') return node.label;
    if (node.type === 'pasted-text') return node.display;
    return '';
  };
  const atomIcon = (node) => {
    if (node.type === 'quote' || (node.type === 'session-link' && node.messageClientId)) return '❝';
    if (node.type === 'mention') return node.kind === 'dir' || node.kind === 'project' ? '⌁' : node.kind === 'agent' ? '◇' : '▧';
    if (node.type === 'session-link') return '↳';
    return '▤';
  };
  const makeNode = (node) => {
    if (node.type === 'text') {
      if (node.slashCommand === node.text) {
        const mark = document.createElement('span');
        mark.className = 'slash';
        mark.dataset.slashValue = node.slashCommand;
        mark.textContent = node.text;
        return mark;
      }
      return document.createTextNode(node.text);
    }
    const atom = document.createElement('span');
    atom.className = 'atom';
    atom.contentEditable = 'false';
    atom.dataset.node = encodeURIComponent(JSON.stringify(node));
    atom.dataset.icon = atomIcon(node);
    atom.textContent = atomLabel(node) || 'Reference';
    atom.setAttribute('role', 'button');
    atom.setAttribute('aria-label', atomLabel(node) || 'Reference');
    atom.tabIndex = -1;
    return atom;
  };
  const makeDomNodes = (node) => {
    const element = makeNode(node);
    return node.type === 'text' ? [element] : [element, makeCaretAnchor()];
  };
  const render = (documentValue, focusAfter) => {
    applying = true;
    root.replaceChildren(...(documentValue.nodes || []).flatMap(makeDomNodes));
    applying = false;
    lastSignature = JSON.stringify(readDocument());
    reportHeight();
    if (focusAfter) placeCaretAtEnd();
  };
  const pushText = (nodes, text, slashCommand) => {
    if (!text) return;
    const previous = nodes[nodes.length - 1];
    if (previous && previous.type === 'text' && previous.slashCommand === slashCommand) previous.text += text;
    else nodes.push(Object.assign({ type: 'text', text }, slashCommand ? { slashCommand } : {}));
  };
  const walk = (parent, nodes) => {
    const children = Array.from(parent.childNodes);
    children.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(nodes, String(child.nodeValue || '').split(CARET_ANCHOR).join(''));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const element = child;
      if (element.classList.contains('atom') && element.dataset.node) {
        try { nodes.push(JSON.parse(decodeURIComponent(element.dataset.node))); } catch (_) {}
        return;
      }
      if (element.tagName === 'BR') {
        pushText(nodes, '\\n');
        return;
      }
      if (element.classList.contains('slash')) {
        const value = element.textContent || '';
        const mark = value === element.dataset.slashValue ? value : undefined;
        pushText(nodes, value, mark);
        return;
      }
      const before = nodes.length ? nodes[nodes.length - 1] : null;
      walk(element, nodes);
      const isBlock = /^(DIV|P|LI)$/.test(element.tagName);
      if (isBlock && index < children.length - 1) {
        const after = nodes.length ? nodes[nodes.length - 1] : null;
        if (after !== before || (after && after.type === 'text')) pushText(nodes, '\\n');
      }
    });
  };
  const readDocument = () => {
    const nodes = [];
    walk(root, nodes);
    return { version: 1, nodes };
  };
  const reportHeight = () => post({ type: 'height', height: Math.min(config.maxHeight, Math.max(${COMPOSER_SINGLE_LINE_HEIGHT}, root.scrollHeight)) });
  const notify = () => {
    if (applying || composing) return;
    const value = readDocument();
    const signature = JSON.stringify(value);
    if (signature !== lastSignature) {
      lastSignature = signature;
      post({ type: 'change', document: value });
    }
    reportHeight();
  };
  const setCaretAfter = (node, selection) => {
    const range = document.createRange();
    if (isCaretAnchor(node)) {
      range.setStart(node, Math.min(CARET_ANCHOR.length, String(node.nodeValue || '').length));
    } else if (node && node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, String(node.nodeValue || '').length);
    } else {
      range.setStartAfter(node);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const placeCaretAtEnd = () => {
    root.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const last = root.lastChild;
    if (last) {
      setCaretAfter(last, selection);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const insertAtSelection = (node) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) placeCaretAtEnd();
    const current = window.getSelection();
    if (!current || current.rangeCount === 0) return;
    const range = current.getRangeAt(0);
    range.deleteContents();
    const inserted = makeDomNodes(node);
    const fragment = document.createDocumentFragment();
    inserted.forEach((element) => fragment.appendChild(element));
    range.insertNode(fragment);
    setCaretAfter(inserted[inserted.length - 1], current);
    notify();
  };
  const createPasteMarker = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) placeCaretAtEnd();
    const current = window.getSelection();
    if (!current || current.rangeCount === 0) return null;
    const range = current.getRangeAt(0);
    range.deleteContents();
    const requestId = String(++pasteRequestSequence);
    const marker = document.createComment('cindy-paste:' + requestId);
    range.insertNode(marker);
    const anchor = makeCaretAnchor();
    marker.parentNode.insertBefore(anchor, marker.nextSibling);
    setCaretAfter(anchor, current);
    pasteMarkers.set(requestId, { marker, anchor });
    return requestId;
  };
  const commitPaste = (requestId, nodes) => {
    const pending = pasteMarkers.get(requestId);
    pasteMarkers.delete(requestId);
    const marker = pending && pending.marker;
    if (!marker || !marker.parentNode) return;
    const inserted = (Array.isArray(nodes) ? nodes : []).flatMap(makeDomNodes);
    inserted.forEach((node) => marker.parentNode.insertBefore(node, marker));
    const selection = window.getSelection();
    const trailing = pending && pending.anchor;
    if (trailing && trailing.parentNode) trailing.remove();
    marker.remove();
    if (selection && inserted.length > 0) setCaretAfter(inserted[inserted.length - 1], selection);
    root.focus();
    notify();
  };
  const resolveSessionLink = (href, semantic) => {
    const label = semantic && semantic.label;
    if (!href || !label) return;
    let changed = false;
    root.querySelectorAll('.atom').forEach((atom) => {
      if (!atom.dataset.node) return;
      try {
        const node = JSON.parse(decodeURIComponent(atom.dataset.node));
        if (node.type !== 'session-link' || node.href !== href || node.titled) return;
        const next = Object.assign({}, node, semantic, { label, titled: true });
        atom.dataset.node = encodeURIComponent(JSON.stringify(next));
        atom.textContent = label;
        atom.setAttribute('aria-label', label);
        changed = true;
      } catch (_) {}
    });
    if (changed) notify();
  };
  const asAtom = (node) =>
    node && node.nodeType === Node.ELEMENT_NODE && node.classList.contains('atom') ? node : null;
  const atomAcrossEmptyAnchor = (node, backward) => {
    let candidate = node;
    if (isEmptyCaretAnchor(candidate)) {
      candidate = backward ? candidate.previousSibling : candidate.nextSibling;
    }
    return asAtom(candidate);
  };
  const adjacentAtom = (backward) => {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    let container = range.startContainer;
    let offset = range.startOffset;
    if (container === root || container.nodeType === Node.ELEMENT_NODE) {
      const child = container.childNodes[backward ? offset - 1 : offset];
      return atomAcrossEmptyAnchor(child, backward);
    }
    if (isCaretAnchor(container)) {
      if (backward && offset <= CARET_ANCHOR.length) return asAtom(container.previousSibling);
      if (!backward && offset >= String(container.nodeValue || '').length) return asAtom(container.nextSibling);
      return null;
    }
    if (container.nodeType === Node.TEXT_NODE && ((backward && offset === 0) || (!backward && offset === container.nodeValue.length))) {
      const sibling = backward ? container.previousSibling : container.nextSibling;
      return atomAcrossEmptyAnchor(sibling, backward);
    }
    return null;
  };
  const removeAtom = (atom) => {
    const parent = atom.parentNode;
    if (!parent) return;
    const index = Array.prototype.indexOf.call(parent.childNodes, atom);
    const anchor = atom.nextSibling;
    let trailing = null;
    if (isCaretAnchor(anchor)) {
      const text = String(anchor.nodeValue || '').slice(CARET_ANCHOR.length);
      if (text) {
        anchor.nodeValue = text;
        trailing = anchor;
      } else {
        anchor.remove();
      }
    }
    atom.remove();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      if (trailing) range.setStart(trailing, 0);
      else range.setStart(parent, Math.min(index, parent.childNodes.length));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };
  const isolateCaretAnchor = (atom) => {
    let anchor = atom.nextSibling;
    if (!isCaretAnchor(anchor)) {
      anchor = makeCaretAnchor();
      atom.parentNode.insertBefore(anchor, atom.nextSibling);
      return anchor;
    }
    const trailing = String(anchor.nodeValue || '').slice(CARET_ANCHOR.length);
    if (trailing) {
      anchor.nodeValue = CARET_ANCHOR;
      anchor.parentNode.insertBefore(document.createTextNode(trailing), anchor.nextSibling);
    }
    return anchor;
  };
  const elementDropRange = (element, clientX, pairAnchor) => {
    const range = document.createRange();
    const rect = element.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) range.setStartBefore(element);
    else range.setStartAfter(pairAnchor || element);
    range.collapse(true);
    return range;
  };
  const placeCaretAroundAtom = (atom, clientX) => {
    root.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = elementDropRange(atom, clientX, isolateCaretAnchor(atom));
    selection.removeAllRanges();
    selection.addRange(range);
  };

  root.addEventListener('input', notify);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; notify(); });
  root.addEventListener('focus', () => post({ type: 'focus' }));
  root.addEventListener('blur', () => post({ type: 'blur' }));
  root.addEventListener('keydown', (event) => {
    const backward = event.key === 'Backspace';
    if (!backward && event.key !== 'Delete') return;
    const atom = adjacentAtom(backward);
    if (!atom) return;
    event.preventDefault();
    removeAtom(atom);
    notify();
  });
  root.addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData && event.clipboardData.items || []);
    const images = items
      .filter((item) => item.type && item.type.startsWith('image/'))
      .slice(0, MAX_PASTED_IMAGE_COUNT);
    if (images.length) {
      event.preventDefault();
      const requestId = 'images-' + String(++pasteRequestSequence);
      post({ type: 'paste-images-start', requestId, count: images.length });
      images.forEach((item, index) => {
        const file = item.getAsFile();
        if (!file) return post({ type: 'paste-image-failed', requestId, index });
        const mimeType = file.type || item.type;
        const name = file.name || ('pasted-image-' + index);
        if (!SUPPORTED_PASTED_IMAGE_MIME_TYPES.has(mimeType) || name.length > MAX_PASTED_IMAGE_NAME_CHARS) {
          return post({ type: 'paste-image-failed', requestId, index });
        }
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const comma = result.indexOf(',');
          const base64 = comma >= 0 ? result.slice(comma + 1) : '';
          if (!base64 || base64.length > MAX_PASTED_IMAGE_BASE64_CHARS) {
            post({ type: 'paste-image-failed', requestId, index });
            return;
          }
          post({
            type: 'paste-image', requestId, index, mimeType, name, base64,
          });
        };
        reader.onerror = () => post({ type: 'paste-image-failed', requestId, index });
        reader.readAsDataURL(file);
      });
      return;
    }
    event.preventDefault();
    const requestId = createPasteMarker();
    if (!requestId) return;
    const clipboardText = event.clipboardData && event.clipboardData.getData('text/plain') || '';
    const text = clipboardText.length <= 4000000 ? clipboardText || undefined : undefined;
    post({ type: 'paste-text-request', requestId, text });
  });

  root.addEventListener('mousedown', (event) => {
    const atom = event.target && event.target.closest && event.target.closest('.atom');
    if (!atom) return;
    event.preventDefault();
    placeCaretAroundAtom(atom, event.clientX);
  });
  root.addEventListener('touchstart', (event) => {
    const atom = event.target && event.target.closest && event.target.closest('.atom');
    const touch = event.touches && event.touches[0];
    if (!atom || !touch) return;
    event.preventDefault();
    placeCaretAroundAtom(atom, touch.clientX);
  }, { passive: false });

  window.cindyComposer = {
    applyDocument(value, focusAfter) { render(value, focusAfter === true); },
    focus() { placeCaretAtEnd(); },
    blur() { root.blur(); },
    insertNode(node) { insertAtSelection(node); },
    commitPaste(requestId, nodes) { commitPaste(requestId, nodes); },
    resolveSessionLink(href, label) { resolveSessionLink(href, label); },
    setConfig(value) { applyConfig(value || {}); reportHeight(); },
  };
  new ResizeObserver(reportHeight).observe(root);
  render(config.document, false);
  post({ type: 'ready' });
})();
</script></body></html>`;
}
