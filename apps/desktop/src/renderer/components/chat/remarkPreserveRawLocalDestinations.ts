/**
 * Preserve the exact local image / link destination before mdast-to-hast URL
 * serialization mangles it.
 *
 * Two distinct failure modes, one mechanism:
 *   - Percent ambiguity: both a real space and the literal filename segment
 *     `%20` reach a custom react-markdown renderer as `%20`.
 *   - Windows backslashes: `normalizeUri` percent-encodes `\` into `%5C`, so a
 *     model-written `[label](C:\Users\...\a.png)` arrives as `C:%5CUsers%5C...`.
 *     That no longer matches the renderer's Windows-absolute whitelist in
 *     `trustedUrlTransform`, falls into react-markdown's default protocol
 *     whitelist (`c:` = unknown scheme), and the href is stripped to `""` —
 *     the link degrades to dead plain text while the same path renders fine
 *     as an image (issue #1629; images were already covered, links were not).
 *
 * Store the mdast value in a neutral data property so the img / a renderers
 * can route the original filesystem path. Links and images use separate
 * property names so neither renderer can accidentally consume the other's
 * channel.
 *
 * Ordering: must run AFTER every plugin that creates image / link nodes with
 * local destinations — remarkHtmlImages (single <img> HTML → mdast image) and
 * remarkLocalPathLinks (bare prose paths → link). Keep it last in the remark
 * plugin lists. remarkSessionLinks emits cindy:// deep links, which the
 * scheme check below skips regardless of order.
 */

import type { Image, Link, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

export const RAW_LOCAL_IMAGE_SRC_PROP = 'data-cindy-raw-local-image-src';
export const RAW_LOCAL_LINK_HREF_PROP = 'data-cindy-raw-local-link-href';

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function isLocalDestination(url: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_RE.test(url) ||
    url.startsWith('file://') ||
    !URL_SCHEME_RE.test(url)
  );
}

const remarkPreserveRawLocalDestinations: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, ['image', 'link'], (node) => {
      const typed = node as Image | Link;
      if (!isLocalDestination(typed.url)) return;

      const prop = node.type === 'image' ? RAW_LOCAL_IMAGE_SRC_PROP : RAW_LOCAL_LINK_HREF_PROP;
      typed.data = {
        ...typed.data,
        hProperties: {
          ...(typed.data?.hProperties ?? {}),
          [prop]: typed.url,
        },
      };
    });
  };
};

export default remarkPreserveRawLocalDestinations;
