import type { ClipboardEvent } from 'react';

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SEMANTIC_CONTAINER_SELECTOR = 'a, strong, b, em, i, u, s, del, code, pre, p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, li, table, thead, tbody, tfoot, tr, th, td';

function isEditable(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(EDITABLE_SELECTOR));
}

/** Keep chat theme styling out of rich-text destinations. */
export function copyChatSelection(event: ClipboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || !event.clipboardData) return;

  const container = event.currentTarget;
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;

  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer) ||
    isEditable(event.target as Node) ||
    isEditable(range.startContainer) ||
    isEditable(range.endContainer)
  ) return;

  const text = selection.toString();
  // Leave image-only selections to Chromium's native image clipboard handling.
  if (!text) return;

  const doc = container.ownerDocument;
  let needsRenderedPlainText = false;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element): CSSStyleDeclaration => {
    let style = styles.get(element);
    if (!style) {
      style = doc.defaultView!.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const inheritedStyle = (element: Element, property: string): string => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const value = styleOf(current).getPropertyValue(property);
      // user-select:auto uses the parent's none/all value even when the
      // computed style itself remains auto (notably in DOM test environments).
      if (value && value !== 'inherit' && !(property === 'user-select' && value === 'auto')) return value;
    }
    return '';
  };
  const unselectable = (element: Element): boolean => {
    // Empty-alt artwork in an explicitly hidden, nonselectable identity mark
    // is decoration, even if a selectable ancestor overrides its computed CSS.
    if (element.matches('img[alt=""]') && element.closest('[aria-hidden="true"].select-none')) {
      needsRenderedPlainText = true;
      return true;
    }
    if (inheritedStyle(element, 'user-select') !== 'none') return false;
    // These renderers identify message content inside preview/navigation
    // controls. Global control CSS must not erase their selected content.
    if (element.closest('[data-chat-copy-content], [data-inline-reference-chip]:not(.select-none), [data-chat-mermaid], [data-chat-image-preview], img')) {
      needsRenderedPlainText = true;
      return false;
    }
    return true;
  };
  const whitespaceOf = (element: Element): string => inheritedStyle(element, 'white-space');
  const preservesWhitespace = (value: string): boolean => /^(pre|pre-wrap|pre-line|break-spaces)$/.test(value);
  const sourceByCopy = new WeakMap<Element, Element>();
  const preserveOrderedStart = (source: Element, copy: Element): void => {
    if (!source.matches('ol')) return;
    const first = [...copy.children].find(child => child.matches('li'));
    const original = first && sourceByCopy.get(first);
    if (!original) return;
    const list = source as HTMLOListElement;
    const items = [...list.children].filter(child => child.matches('li')) as HTMLLIElement[];
    let ordinal = list.hasAttribute('start') ? list.start : list.reversed ? items.length : 1;
    for (const item of items) {
      if (/^[+-]?\d+$/.test(item.getAttribute('value')?.trim() ?? '')) ordinal = item.value;
      if (item === original) {
        (copy as HTMLOListElement).start = ordinal;
        return;
      }
      ordinal += list.reversed ? -1 : 1;
    }
  };
  const shell = (element: Element): Element => {
    const copy = element.cloneNode(false) as Element;
    sourceByCopy.set(copy, element);
    for (const attribute of ['style', 'class', 'bgcolor', 'color']) copy.removeAttribute(attribute);
    if (element.matches('[role="button"], [data-inline-reference-chip]') && !element.matches('a[href]')) {
      // React actions are not cloned. Export clickable content as ordinary
      // content rather than a focusable control with no activation handler.
      for (const attribute of ['role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-controls', 'aria-haspopup', 'data-split-pane-route-action']) copy.removeAttribute(attribute);
    }
    // Whitespace is content formatting, not a theme color. Preserve only this
    // allowlisted declaration so user-message newlines/indentation survive HTML paste.
    const whitespace = whitespaceOf(element);
    if (preservesWhitespace(whitespace)) copy.setAttribute('style', `white-space: ${whitespace};`);
    if (element.matches('img:not([data-gallery-src]):not([data-chat-audio-cover])') &&
        !element.closest('[data-chat-image-preview]')) {
      // Content images also occur outside gallery wrappers (site posters and
      // plugin avatars). Materialize class-based geometry before removing CSS.
      const image = element as HTMLImageElement;
      const target = copy as HTMLImageElement;
      const computed = styleOf(element);
      for (const property of ['width', 'height', 'max-width', 'max-height', 'aspect-ratio', 'object-fit']) {
        const value = image.style.getPropertyValue(property) || computed.getPropertyValue(property);
        if (value && value !== 'none' && value !== 'auto') target.style.setProperty(property, value);
      }
      if (!target.style.maxWidth) target.style.maxWidth = '100%';
      // A poster's authored ratio must remain responsive in a narrower target.
      if (target.style.aspectRatio && !image.style.height) target.style.height = 'auto';
      target.removeAttribute('role');
      target.removeAttribute('tabindex');
    }
    if (element.matches('[data-chat-image-preview] img, img[data-gallery-src]')) {
      // The image is content; the surrounding lightbox button is application
      // chrome. Keep only its inline sizing limits, never theme declarations.
      for (const property of ['width', 'height', 'max-width', 'max-height', 'object-fit', 'object-position']) {
        const value = (element as HTMLImageElement).style.getPropertyValue(property);
        if (value) (copy as HTMLImageElement).style.setProperty(property, value);
      }
      const fit = styleOf(element).objectFit;
      if (fit) (copy as HTMLImageElement).style.objectFit = fit;
      // Tall attachment thumbnails put their square bounds on the parent and
      // fill it with percentage dimensions. That containing block is stripped
      // during copy; materialize its bounded geometry on the detached image.
      const image = element as HTMLImageElement;
      const parent = image.parentElement as HTMLElement | null;
      const width = parent?.style.width;
      const ratio = parent?.style.aspectRatio;
      if (image.style.width === '100%' && image.style.height === '100%' &&
          width && ratio && /^\d+(?:\.\d+)?px$/.test(width) && /^1(?:\s*\/\s*1)?$/.test(ratio)) {
        const target = copy as HTMLImageElement;
        target.style.width = width;
        target.style.maxWidth = '100%';
        target.style.height = 'auto';
        target.style.maxHeight = width;
        target.style.aspectRatio = ratio;
      }
      // A gallery image remains content after its live preview action is gone.
      copy.removeAttribute('role');
      copy.removeAttribute('tabindex');
    }
    if (element.matches('[data-chat-image-preview] img, img[data-gallery-src]')) {
      const media = element.closest<HTMLElement>('.rich-answer-media');
      const geometry = [['width', '--rich-width'], ['height', '--rich-height'],
        ['max-width', '--rich-maxWidth'],
        ['min-height', '--rich-minHeight'], ['max-height', '--rich-maxHeight']] as const;
      if (media && geometry.some(([, token]) => media.style.getPropertyValue(token))) {
        // RichAnswer's important media rule overrides the preview's inline
        // defaults. Transfer the authored variables before removing that owner.
        const target = copy as HTMLImageElement;
        target.style.maxWidth = '100%';
        target.style.height = 'auto';
        for (const [property, token] of geometry) {
          const value = media.style.getPropertyValue(token);
          if (value) target.style.setProperty(property, property === 'max-width' ? `min(100%, ${value})` : value);
        }
      }
    }
    if (element.closest('.katex-html')) {
      // Partial equations cannot use the whole-formula MathML shortcut. Keep
      // only KaTeX's selected visual geometry, without theme color/background.
      const computed = styleOf(element);
      for (const property of ['display', 'position', 'top', 'right', 'bottom', 'left',
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'vertical-align', 'line-height', 'font-size', 'font-style', 'font-weight',
        'letter-spacing', 'text-align', 'white-space', 'transform',
        'border-top-style', 'border-top-width', 'border-right-style', 'border-right-width',
        'border-bottom-style', 'border-bottom-width', 'border-left-style', 'border-left-width',
        'border-collapse', 'border-spacing']) {
        const value = (element as HTMLElement).style.getPropertyValue(property) || computed.getPropertyValue(property);
        if (value) (copy as HTMLElement).style.setProperty(property, value);
      }
      if (/^KaTeX_/i.test(computed.fontFamily)) (copy as HTMLElement).style.fontFamily = computed.fontFamily;
    }
    if (element.matches('img[data-chat-audio-cover]')) {
      // Audio artwork is content, but its display box lives on the parent.
      // Carry that bounded size onto the image so detached HTML cannot expand
      // to the source cover's intrinsic resolution.
      for (const property of ['width', 'height']) {
        const value = (element.parentElement as HTMLElement | null)?.style.getPropertyValue(property);
        if (value) (copy as HTMLImageElement).style.setProperty(property, value);
      }
      const fit = styleOf(element).objectFit;
      if (fit) (copy as HTMLImageElement).style.objectFit = fit;
    }
    return copy;
  };
  const preserveTextBoundaries = (source: Element, copy: Element | DocumentFragment): void => {
    if (!copy.textContent?.trim() || source.closest('.katex-html')) return;
    const style = styleOf(source);
    const gap = style.columnGap && style.columnGap !== 'normal'
      ? style.columnGap : style.gap.split(/\s+/).at(-1) ?? '';
    // Grid cells remain distinct even with zero gap (for example sheet numbers).
    const gridCells = ['grid', 'inline-grid'].includes(style.display);
    // Flex gaps carry word boundaries even when adjacent JSX has no whitespace.
    // Export text separators rather than retaining the application's layout CSS.
    if (gridCells || (['flex', 'inline-flex'].includes(style.display) &&
        !style.flexDirection.startsWith('column') && (parseFloat(gap) > 0 ||
          ['space-between', 'space-around', 'space-evenly'].includes(style.justifyContent)))) {
      let previous: Node | undefined;
      for (const child of [...copy.childNodes]) {
        if (previous && !/\s$/.test(previous.textContent ?? '') && !/^\s/.test(child.textContent ?? '')) {
          copy.insertBefore(doc.createTextNode(' '), child);
          needsRenderedPlainText = true;
        }
        previous = child;
      }
    }
    // Block-like spans (notably document titles/metadata) otherwise become
    // inline when their classes disappear. BRs preserve the visible line breaks;
    // literal newlines also keep textContent-only clipboard consumers separated.
    const parentStyle = source.parentElement && styleOf(source.parentElement);
    // Flex row items are blockified by layout even when their authored tag is
    // inline. Keep those labels on the same line; the row's gap supplies spaces.
    const rowItem = style.display === 'block' && parentStyle &&
      (['grid', 'inline-grid'].includes(parentStyle.display) ||
        (['flex', 'inline-flex'].includes(parentStyle.display) && !parentStyle.flexDirection.startsWith('column')));
    if (source.localName === 'span' && !rowItem && ['block', 'flex', 'grid'].includes(style.display)) {
      copy.prepend(doc.createElement('br'), doc.createTextNode('\n'));
      copy.append(doc.createElement('br'), doc.createTextNode('\n'));
      needsRenderedPlainText = true;
    }
  };
  const cloneSelected = (node: Node): Node | null => {
    if (!range.intersectsNode(node)) return null;
    // Application chrome and screen-reader copies are excluded even when the
    // selection starts inside them, bypassing their marked wrapper entirely.
    const sourceElement = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (sourceElement?.closest('.sr-only, [data-chat-video-preview], [data-chat-copy-exclude]')) {
      needsRenderedPlainText = true;
      return null;
    }
    // Closed disclosures hide their body through UA rendering, not computed
    // display/visibility. Only their first direct summary is rendered.
    const parent = node.parentElement;
    if (parent?.matches('details:not([open])') &&
        node !== [...parent.children].find(child => child.matches('summary'))) {
      needsRenderedPlainText = true;
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement!;
      if (['hidden', 'collapse'].includes(inheritedStyle(parent, 'visibility')) || unselectable(parent)) return null;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.textContent!.length;
      return doc.createTextNode(node.textContent!.slice(start, end));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element;
    if (styleOf(element).display === 'none' || styleOf(element).contentVisibility === 'hidden') return null;
    if (styleOf(element).opacity === '0') {
      // Hover-only controls must not become visible after theme classes are
      // removed. Descendants cannot override a composited zero opacity.
      needsRenderedPlainText = true;
      return null;
    }
    if (element.matches('[data-chat-rich-bar]') &&
        !['hidden', 'collapse'].includes(inheritedStyle(element, 'visibility')) &&
        !unselectable(element)) {
      const bar = element.firstElementChild as HTMLElement | null;
      if (!bar) return null;
      // Div backgrounds using currentColor are discarded by Chromium paste.
      // Use one portable drawing instead; neutral ink inherits the destination,
      // while explicit drawing paint and signed bar geometry remain content.
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('data-chat-rich-bar', '');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', styleOf(element).height || '8px');
      const rect = doc.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('x', bar.style.marginLeft);
      rect.setAttribute('width', bar.style.width);
      rect.setAttribute('height', '100%');
      rect.setAttribute('rx', styleOf(element).borderRadius || '0');
      const paint = bar.style.backgroundColor;
      const neutral = !paint || /^(?:currentcolor|var\(--(?:text-(?:primary|secondary|tertiary)|border-default)\))$/i.test(paint);
      rect.setAttribute('fill', neutral ? 'currentColor'
        : paint.startsWith('var(') ? styleOf(bar).backgroundColor : paint);
      svg.appendChild(rect);
      return svg;
    }
    // Reference-chip icons are decoration, not selected message content.
    if (element.matches('svg') && element.closest('[data-inline-reference-chip] [aria-hidden="true"]')) return null;
    if (element.matches('[data-chat-mermaid] > svg, svg[data-chat-rich-svg]') && range.comparePoint(element, 0) === 0 &&
        range.comparePoint(element, element.childNodes.length) === 0 &&
        !['hidden', 'collapse'].includes(inheritedStyle(element, 'visibility')) &&
        !unselectable(element)) {
      // Complete content drawings are atomic. Each renderer determines which
      // presentation belongs to its drawing, rather than the surrounding chat.
      const copy = element.cloneNode(true) as SVGElement;
      const originals = [element, ...element.querySelectorAll('*')];
      const copies = [copy, ...copy.querySelectorAll('*')];
      if (element.hasAttribute('data-chat-rich-svg')) {
        // RichAnswer's neutral paint roles belong to the chat theme, unlike
        // Mermaid's self-contained drawing CSS. Keep them as destination ink;
        // only explicitly chosen semantic drawing colors are materialized.
        const chart = element.getAttribute('data-chat-rich-svg') === 'chart';
        originals.forEach((original, index) => {
          const target = copies[index] as SVGElement;
          for (const attribute of ['style', 'class', 'color', 'bgcolor']) target.removeAttribute(attribute);
          const authored = (original as SVGElement).style;
          // A vector can choose semantic ink on its root and let unpainted
          // shapes inherit currentColor. Keep that authored ink, while neutral
          // roles and host-inherited color remain destination-adaptive.
          const ink = authored.getPropertyValue('color');
          if (ink && !/^(?:currentcolor|var\(--(?:text-(?:primary|secondary|tertiary)|border-default)\))$/i.test(ink)) {
            target.style.color = ink.startsWith('var(') ? styleOf(original).color : ink;
          }
          for (const property of ['fill', 'stroke']) {
            const paint = authored.getPropertyValue(property);
            if (!paint) continue;
            const neutral = /^(?:currentcolor|var\(--(?:text-(?:primary|secondary|tertiary)|border-default)\))$/i.test(paint);
            target.style.setProperty(property, neutral ? 'currentColor'
              : paint.startsWith('var(') ? styleOf(original).getPropertyValue(property) : paint);
          }
          // The chart's class-based grid and labels have no authored paint.
          if (chart && original.localName === 'line') target.style.stroke = 'currentColor';
          if (chart && original.localName === 'text') target.style.fontSize = styleOf(original).fontSize;
          // Keep only explicitly authored typography, never inherited host fonts.
          for (const property of ['width', 'height', 'max-width', 'max-height',
            'font-size', 'font-family', 'font-weight', 'font-style', 'letter-spacing']) {
            const value = authored.getPropertyValue(property);
            if (value) target.style.setProperty(property, value);
          }
        });
        if (chart) {
          // The renderer's responsive root width lives in class-based CSS.
          // Carry it across without freezing the source message column size.
          copy.style.width ||= '100%';
          copy.style.maxWidth ||= '100%';
        }
        copy.style.fill ||= 'currentColor';
        return copy;
      }
      // Mermaid's preview bounds live in parent-selector CSS. Transfer them
      // before unwrapping that parent so intrinsic SVG sizes cannot expand paste.
      for (const property of ['max-width', 'max-height']) {
        const value = styleOf(element).getPropertyValue(property);
        if (value && value !== 'none') {
          copy.style.setProperty(property, value);
          copy.style.width = 'auto';
          copy.style.height = 'auto';
        }
      }
      // Clipboard consumers may discard SVG <style> elements. Materialize the
      // drawing's presentation so its geometry remains legible without them.
      const presentation = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
        'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
        'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'color', 'font-family',
        'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
        'marker-start', 'marker-mid', 'marker-end', 'visibility', 'white-space'];
      originals.forEach((original, index) => {
        const target = copies[index] as SVGElement | HTMLElement;
        for (const property of presentation) {
          const value = styleOf(original).getPropertyValue(property);
          if (value) target.style.setProperty(property, value.replaceAll(`${doc.URL.split('#')[0]}#`, '#'));
        }
      });
      return copy;
    }
    if (element.matches('.katex')) {
      const math = element.querySelector('.katex-mathml > math');
      const visual = element.querySelector('.katex-html');
      let fullVisual = Boolean(visual && range.comparePoint(visual, 0) === 0 &&
        range.comparePoint(visual, visual.childNodes.length) === 0);
      if (visual && !fullVisual) {
        // A drag starts/ends in text leaves, excluding the visual wrapper's
        // empty layout spans and the preceding clipped MathML sibling.
        const walker = doc.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
        const leaves: Node[] = [];
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.replace(/[\s\u200b]/g, '')) leaves.push(walker.currentNode);
        }
        fullVisual = leaves.length > 0 && leaves.every(leaf =>
          range.comparePoint(leaf, 0) === 0 && range.comparePoint(leaf, leaf.textContent!.length) === 0);
      }
      if (math && fullVisual) {
        // KaTeX's clipped accessibility MathML and its visual layout describe
        // the same equation. Export just the semantic tree, without unwrapping
        // the visual spans into a second, unstyled equation. Visual-only partial
        // selections continue through the normal range-aware path below.
        const copy = math.cloneNode(true) as Element;
        for (const part of [copy, ...copy.querySelectorAll('*')]) {
          for (const attribute of ['style', 'class', 'bgcolor', 'color']) part.removeAttribute(attribute);
        }
        needsRenderedPlainText = true;
        return copy;
      }
      // A prose-to-equation drag can fully intersect the preceding hidden
      // MathML while selecting only a visual prefix. Keep only the selected
      // visual slice; never substitute the unselected rest of the formula.
      if (math && visual) {
        needsRenderedPlainText = true;
        const copy = cloneSelected(visual) as Element | null;
        // With the duplicate MathML omitted, the visual slice is the sole
        // representation and must no longer be hidden from screen readers.
        copy?.removeAttribute('aria-hidden');
        return copy;
      }
    }
    if (element.matches('li.task-list-item > input[type="checkbox"][disabled]')) {
      if (['hidden', 'collapse'].includes(inheritedStyle(element, 'visibility')) ||
          unselectable(element)) return null;
      // Disabled GFM task checkboxes are content, rather than editable fields.
      // Unicode markers survive HTML consumers that discard form controls.
      needsRenderedPlainText = true;
      return doc.createTextNode((element as HTMLInputElement).checked ? '☑' : '☐');
    }
    if (element.matches('input, textarea, select')) {
      // Intermediate interactive fields are UI state, not selected message
      // content. Never serialize their values, options or active checkbox state.
      needsRenderedPlainText = true;
      return null;
    }
    if (element.matches('button, [data-chat-mermaid]')) {
      // Selectable card headers and image triggers contribute content, not a
      // portable button action. Keep only their selected children; marked
      // controls were excluded above and selection/visibility filters still apply.
      const children = doc.createDocumentFragment();
      for (const child of element.childNodes) {
        const selected = cloneSelected(child);
        if (selected) children.appendChild(selected);
      }
      preserveTextBoundaries(element, children);
      return children.hasChildNodes() ? children : null;
    }
    const copy = shell(element);
    for (const child of element.childNodes) {
      const selected = cloneSelected(child);
      if (selected) copy.appendChild(selected);
    }
    preserveOrderedStart(element, copy);
    preserveTextBoundaries(element, copy);
    // Empty semantic nodes carry spacing/list positions; SVG leaf geometry
    // carries drawing commands without text children. Do not prune either.
    const preservesEmpty = Boolean(element.closest('.katex-html')) || element.matches('br, img, hr, th, td') ||
      element.namespaceURI === 'http://www.w3.org/2000/svg' ||
      (!element.hasChildNodes() && element.matches(SEMANTIC_CONTAINER_SELECTOR));
    if (!copy.hasChildNodes() && !preservesEmpty) return null;
    if (!copy.hasChildNodes() && (['hidden', 'collapse'].includes(inheritedStyle(element, 'visibility')) ||
        unselectable(element))) return null;
    return copy;
  };

  const content = doc.createElement('div');
  let fragment: Node = doc.createDocumentFragment();
  const originalCommon = range.commonAncestorContainer;
  const commonElement = originalCommon.nodeType === Node.ELEMENT_NODE
    ? originalCommon as Element : originalCommon.parentElement;
  const equation = commonElement?.closest('.katex');
  // Visit the equation handler even when both endpoints are inside its visual
  // subtree. The range itself remains unchanged for partial-copy boundaries.
  const common = equation && container.contains(equation) ? equation : originalCommon;
  const commonIsAtomic = common.nodeType === Node.ELEMENT_NODE && (common as Element).matches('.katex, svg');
  // Walk the original selected DOM before stripping styles. cloneContents would
  // resurrect hidden measurement mirrors and non-selectable quote summaries.
  for (const node of common.nodeType === Node.TEXT_NODE || commonIsAtomic ? [common] : common.childNodes) {
    const selected = cloneSelected(node);
    if (selected) fragment.appendChild(selected);
  }
  // The common container's children bypass cloneSelected(container), including
  // its flex-gap boundary handling. Apply that once before reconstructing it.
  const commonBoundariesApplied = common.nodeType === Node.ELEMENT_NODE && !commonIsAtomic;
  if (commonBoundariesApplied) preserveTextBoundaries(common as Element, fragment as DocumentFragment);
  // Retain semantic ancestors so
  // selecting a word inside a link or bold text does not lose its meaning.
  let ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  if (commonIsAtomic) ancestor = common.parentElement;
  while (ancestor && ancestor !== container) {
    if (ancestor.matches(SEMANTIC_CONTAINER_SELECTOR) || preservesWhitespace(whitespaceOf(ancestor))) {
      const wrapper = shell(ancestor);
      wrapper.appendChild(fragment);
      preserveOrderedStart(ancestor, wrapper);
      if (!commonBoundariesApplied || ancestor !== common) preserveTextBoundaries(ancestor, wrapper);
      fragment = wrapper;
    }
    ancestor = ancestor.parentElement;
  }
  content.append(fragment);
  // Supplying our own HTML prevents Chromium from inlining ancestor backgrounds.

  let plainText = text;
  if (needsRenderedPlainText) {
    // Chromium Selection.toString() can include a closed details body even
    // though native copy excludes it. Read the filtered fragment's rendered
    // text so the plain flavor cannot disclose fields omitted from the HTML,
    // and so converted task markers and equations agree in both formats.
    // Layout is needed for paragraph/table separators; never change the source.
    const staging = doc.createElement('div');
    staging.setAttribute('aria-hidden', 'true');
    staging.style.cssText = 'position:fixed;left:-100000px;top:0;';
    staging.appendChild(content);
    try {
      doc.body.appendChild(staging);
      plainText = content.innerText ?? content.textContent ?? '';
    } finally {
      staging.remove();
    }
  }
  event.clipboardData.setData('text/plain', plainText);
  event.clipboardData.setData('text/html', content.innerHTML);
  event.preventDefault();
}
