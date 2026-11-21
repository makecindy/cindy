import type { Element, Root, Text } from 'hast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { classifyMarkdownLinkTarget, splitLocalLineSuffix } from '@/lib/markdownTarget';
import { resolveLocalPath } from '@/lib/localPathResolver';
import { BARE_PATH_ATTR } from './remarkLocalPathLinks';
import { RAW_LOCAL_LINK_HREF_PROP } from './remarkPreserveRawLocalDestinations';

export const LINK_CODE_LABEL_PROP = 'data-cindy-link-code-label';

interface PathLabel {
  node: Text;
  path: string;
  segments: string[];
  suffix: string;
}

function addLabelOwner(owners: Map<string, Set<string>>, label: string, path: string) {
  const paths = owners.get(label);
  if (paths) paths.add(path);
  else owners.set(label, new Set([path]));
}

export function localLinkLabelPath(href: string): string | undefined {
  const target = classifyMarkdownLinkTarget(href);
  if (target.kind !== 'local-candidate') return undefined;
  return (target.href.toLowerCase().startsWith('file://')
    ? resolveLocalPath('file://' + target.href.slice('file://'.length), '')
    : target.href).replaceAll('\\', '/');
}

export function absoluteFileLabelName(path: string, label: string): string | undefined {
  if (!/^(?:\/(?!\/)|[A-Za-z]:\/)/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return undefined;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name && label === label.trim() && splitLocalLineSuffix(label).href === name ? name : undefined;
}

// Run after heading IDs are assigned. Reference links are already expanded
// here, and neither heading anchors nor authored destinations need rewriting.
const rehypeDisambiguateLocalLinks: Plugin<[], Root> = () => (tree) => {
  const groups = new Map<string, PathLabel[]>();
  const existingLabels = new Map<string, Set<string>>();
  visit(tree, 'element', (link: Element) => {
    if (link.tagName !== 'a') return;
    visit(link, 'element', (child: Element) => {
      if (child.tagName === 'code') child.properties[LINK_CODE_LABEL_PROP] = true;
    });

    const [child] = link.children;
    if (link.children.length !== 1) return;
    const node = child?.type === 'element' && child.tagName === 'code' && child.children.length === 1
      ? child.children[0] : child;
    if (node?.type !== 'text') return;

    const href = link.properties[RAW_LOCAL_LINK_HREF_PROP];
    if (typeof href !== 'string') return;
    const path = localLinkLabelPath(href);
    if (path === undefined) return;
    addLabelOwner(existingLabels, node.value, path);
    if (link.properties[BARE_PATH_ATTR] !== undefined) return;
    const name = absoluteFileLabelName(path, node.value);
    if (!name) return;
    const segments = path.split('/');
    const entry = { node, path, segments, suffix: node.value.slice(name.length) };
    const group = groups.get(name);
    if (group) group.push(entry);
    else groups.set(name, [entry]);
  });

  for (const group of groups.values()) {
    if (new Set(group.map(entry => entry.path)).size < 2) continue;
    const candidateOwners = new Map<string, Set<string>>();
    for (const { path, segments, suffix } of group) {
      for (let length = 2; length <= segments.length; length++) {
        addLabelOwner(candidateOwners, segments.slice(-length).join('/') + suffix, path);
      }
    }
    for (const { node, path, segments, suffix } of group) {
      for (let length = 2; length <= segments.length; length++) {
        const label = segments.slice(-length).join('/') + suffix;
        const existing = existingLabels.get(label);
        if (candidateOwners.get(label)?.size !== 1 || (existing && (existing.size !== 1 || !existing.has(path)))) continue;
        node.value = label;
        break;
      }
    }
  }
};

export default rehypeDisambiguateLocalLinks;
