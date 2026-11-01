import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import rendererTailwindConfig from '../../../tailwind.config';

// Load production CSS as a behavioral fixture, not a source-text assertion.
// jsdom cannot parse Tailwind/layer syntax. Keep the actual selection rules in
// their original order and specificity, without copying their selector lists.
const source = postcss.parse(readFileSync(resolve(__dirname, '../../renderer/styles/globals.css'), 'utf8'));
const selectionStyles = postcss.root();
source.walkRules(rule => {
  const declarations = (rule.nodes ?? []).filter(node => node.type === 'decl' &&
    (node.prop === 'user-select' || node.prop === '-webkit-user-select'));
  if (declarations.length) selectionStyles.append(rule.clone({ nodes: declarations.map(node => node.clone()) }));
});
if (!selectionStyles.nodes.length) throw new Error('Production renderer selection styles were not loaded');
const css = selectionStyles.toString();

export function installRendererSelectionStyles(doc: Document = document): HTMLStyleElement {
  const style = doc.createElement('style');
  style.dataset.copyTest = '';
  style.textContent = css;
  doc.head.appendChild(style);
  return style;
}

// Compile actual production classes; jsdom cannot match escaped arbitrary
// Tailwind class names. Alias class tokens in both CSS and the rendered fixture,
// retaining actual declarations/combinators/specificity. Native-browser checks
// use the unmodified compiler output.
let rendererUtilities: Promise<{ css: string; aliases: Map<string, string> }> | undefined;
export async function installRendererClipboardStyles(root: Element): Promise<HTMLStyleElement> {
  rendererUtilities ??= postcss([tailwindcss({
    ...rendererTailwindConfig,
    content: ['MarkdownMermaidBlock', 'VideoSitePreview', 'GhostSummonCard', 'GeneratedFilesCard'].map(name =>
      resolve(__dirname, `../../renderer/components/chat/${name}.tsx`)),
  })]).process('@tailwind utilities;', { from: undefined }).then(result => {
    // jsdom leaves gap custom properties unresolved. Use the actual generated
    // spacing tokens for these geometry declarations; native fixtures load the
    // unmodified tokens and compiler output instead.
    const spacingTokens = new Map<string, string>();
    postcss.parse(readFileSync(resolve(__dirname, '../../renderer/styles/generated/tokens.css'), 'utf8'))
      .walkDecls(decl => { if (decl.prop.startsWith('--space-')) spacingTokens.set(decl.prop, decl.value); });
    result.root.walkDecls(/^(?:column-gap|row-gap|gap)$/, decl => {
      decl.value = decl.value.replace(/var\((--space-[\w-]+)\)/g, (value, name) => spacingTokens.get(name) ?? value);
    });
    const aliases = new Map<string, string>();
    result.root.walkRules(rule => {
      rule.selector = rule.selector.replace(/\.((?:\\.|[\w-])+)/g, (_match, token: string) => {
        const name = token.replace(/\\(.)/g, '$1');
        if (!aliases.has(name)) aliases.set(name, `compiled-utility-${aliases.size}`);
        return `.${aliases.get(name)}`;
      });
    });
    return { css: result.root.toString(), aliases };
  });
  const { css: utilities, aliases } = await rendererUtilities;
  for (const element of [root, ...root.querySelectorAll('[class]')]) {
    for (const name of [...element.classList]) {
      const alias = aliases.get(name);
      if (alias) element.classList.add(alias);
    }
  }
  const style = root.ownerDocument.createElement('style');
  style.dataset.copyTest = '';
  style.textContent = utilities;
  root.ownerDocument.head.appendChild(style);
  return style;
}

// Dispatch through the rendered view's actual event ownership, never call the
// handler directly; a missing onCopy must leave the event unhandled.
export function copyRenderedSelection(element: Element) {
  const doc = element.ownerDocument;
  const selection = doc.getSelection()!;
  const range = doc.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  const formats = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: {
    setData: (type: string, value: string) => formats.set(type, value),
  } });
  try { element.dispatchEvent(event); } finally { selection.removeAllRanges(); }
  return { event, formats };
}
