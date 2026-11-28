import { describeExternalLink, externalLinkLabel } from '@cindy/maker-shared/external-link';
import type { MobileMarkdownInline } from './messageMarkdown';

type MarkdownLink = Extract<MobileMarkdownInline, { type: 'link' }>;

export function groupExternalLinkDisplay(link: MarkdownLink) {
  const info = link.text === link.url ? describeExternalLink(link.url) : null;
  return info ? { text: externalLinkLabel(info), github: info.kind === 'github' } : { text: link.text, github: false };
}

export const groupExternalLinkText = (link: MarkdownLink): string => groupExternalLinkDisplay(link).text;
