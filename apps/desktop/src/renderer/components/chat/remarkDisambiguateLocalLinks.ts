import type { InlineCode, Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { classifyMarkdownLinkTarget, splitLocalLineSuffix } from '@/lib/markdownTarget';

interface PathLabel {
  node: Text | InlineCode;
  path: string;
  segments: string[];
  suffix: string;
}

// Shorten the display only. The link keeps its original destination and resolution rules.
const remarkDisambiguateLocalLinks: Plugin<[], Root> = () => (tree) => {
  const groups = new Map<string, PathLabel[]>();
  visit(tree, 'link', (link) => {
    const [node] = link.children;
    if (link.children.length !== 1 || (node?.type !== 'text' && node?.type !== 'inlineCode')) return;

    const target = classifyMarkdownLinkTarget(link.url);
    if (target.kind !== 'local-candidate') return;
    const path = target.href.replaceAll('\\', '/');
    if (!/^(?:\/(?!\/)|[A-Za-z]:\/)/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return;
    const segments = path.split('/');
    const name = segments.at(-1);
    const label = splitLocalLineSuffix(node.value).href;
    if (!name || label !== name || node.value !== node.value.trim()) return;
    const entry = { node, path, segments, suffix: node.value.slice(label.length) };
    const group = groups.get(name);
    if (group) group.push(entry);
    else groups.set(name, [entry]);
  });

  for (const group of groups.values()) {
    const paths = new Map(group.map(entry => [entry.path, entry.segments]));
    if (paths.size < 2) continue;
    const counts = new Map<string, number>();
    for (const segments of paths.values()) {
      for (let length = 2; length <= segments.length; length++) {
        const label = segments.slice(-length).join('/');
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    for (const { node, segments, suffix } of group) {
      for (let length = 2; length <= segments.length; length++) {
        const label = segments.slice(-length).join('/');
        if (counts.get(label) !== 1) continue;
        node.value = label + suffix;
        break;
      }
    }
  }
};

export default remarkDisambiguateLocalLinks;
