/**
 * Generic checks every variant receives, evaluated inside the page. Errors fail the
 * variant; warnings are reported for the agent to judge against the screenshots.
 */
export function pageAudit() {
  const describe = (el) => {
    const testId = el.getAttribute('data-testid');
    const classes =
      typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
    return `${el.tagName.toLowerCase()}${testId ? `[data-testid="${testId}"]` : ''}${classes ? `.${classes}` : ''}`;
  };
  const text = (el) =>
    (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const clipped = [];
  const truncatedWithoutTitle = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (clipped.length + truncatedWithoutTitle.length >= 40) break;
    if (!el.getClientRects().length) continue;
    if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()))
      continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    // Standard screen-reader-only text is intentionally clipped, not visually truncated.
    // Keep auditing ordinary clipped labels, including elements with an sr-only class
    // that is not actually hidden by CSS.
    if (style.position === 'absolute' && parseFloat(style.width) <= 1
      && parseFloat(style.height) <= 1 && style.clip === 'rect(0px, 0px, 0px, 0px)') continue;
    const overflowX = el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(style.overflowX);
    const clamped = style.webkitLineClamp && style.webkitLineClamp !== 'none';
    const overflowY =
      !clamped && el.scrollHeight > el.clientHeight + 2 && /hidden|clip/.test(style.overflowY);
    const item = { element: describe(el), text: text(el) };
    if (overflowX && style.textOverflow === 'ellipsis') {
      if (!el.closest('[title]')) truncatedWithoutTitle.push(item);
    } else if (overflowX || overflowY) clipped.push({ ...item, axis: overflowX ? 'x' : 'y' });
  }
  const runtime = window.__uiPage;
  // Three or more segments read as a key on their own; two-segment text (`bots.send`, but also
  // `example.com`) counts only when it is an actual translation key.
  const rawKeys = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && rawKeys.length < 20) {
    const value = walker.currentNode.textContent.trim();
    if (!/^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/.test(value)) continue;
    if (/(\.[^.]+){2,}/.test(value) || runtime.isTranslationKey?.(value)) rawKeys.push(value);
  }
  return {
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    rawKeys,
    clipped,
    truncatedWithoutTitle,
    missingTranslations: runtime.missingTranslations.slice(0, 50),
    mutations: runtime.mutations.slice(),
    hostMissing: runtime.hostMissing.slice(),
  };
}

export function auditOutcome(audit) {
  const errors = [];
  if (audit.horizontalOverflow) errors.push('page overflows horizontally');
  if (audit.rawKeys.length) errors.push(`untranslated keys rendered: ${audit.rawKeys.join(', ')}`);
  if (audit.mutations.length)
    errors.push(`host mutations attempted: ${audit.mutations.join(', ')}`);
  const warnings = [
    ...audit.clipped.map((item) => `clipped text (${item.axis}) ${item.element}: "${item.text}"`),
    ...audit.truncatedWithoutTitle.map(
      (item) => `truncated without title ${item.element}: "${item.text}"`,
    ),
    ...audit.missingTranslations.map((entry) => `missing translation ${entry}`),
  ];
  return { errors, warnings };
}
