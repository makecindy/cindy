/** Bounded discovery only: never evaluate project configuration or render remote HTML. */
import path from 'node:path';
import sharp from 'sharp';
export interface DiscoveredProjectIcon {
  image: string;
  source: string;
  kind: 'local' | 'website' | 'github';
  candidate: boolean;
}
export interface IconDiscoveryIO {
  directoryName?: string;
  read(relative: string): Promise<Buffer | null>;
  fetch(url: string): Promise<{ bytes: Buffer; url: string } | null>;
  gitOrigin?(): Promise<string | null>;
}
export function safeIconUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
function json(bytes: Buffer | null): any {
  try {
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  } catch {
    return null;
  }
}
export function localIconPath(value: unknown, base = ''): string | null {
  if (typeof value !== 'string' || value.length > 1024 || /[\0\\?#:]/.test(value)) return null;
  const result = path.posix.normalize(path.posix.join(base, value.replace(/^\.\//, '')));
  return result.startsWith('/') || result === '..' || result.startsWith('../') ? null : result;
}
/** Only PNG entries in ICO are accepted; unsupported old bitmap entries fall back safely. */
export async function projectIconThumbnail(input: Buffer): Promise<string | null> {
  try {
    if (!input.length || input.length > 1024 * 1024) return null;
    if (input.length >= 6 && input.readUInt32LE(0) === 65536) {
      const count = Math.min(input.readUInt16LE(4), 64);
      const entries: Buffer[] = [];
      for (let i = 0; i < count && 6 + (i + 1) * 16 <= input.length; i++) {
        const at = 6 + i * 16;
        const size = input.readUInt32LE(at + 8),
          offset = input.readUInt32LE(at + 12);
        if (
          offset + size <= input.length &&
          size >= 8 &&
          input.subarray(offset, offset + 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          entries.push(input.subarray(offset, offset + size));
      }
      if (!entries.length) return null;
      input = entries.sort((a, b) => b.length - a.length)[0]!;
    }
    const header = input.toString('utf8');
    if (/<svg[\s>]/i.test(header)) {
      // A logo is rasterized server-side, never passed through as active SVG.
      if (
        /<!|<\?xml-stylesheet|<(?:script|foreignObject|image|use)\b|\b(?:href|src)\s*=|url\s*\(|@import/i.test(
          header,
        )
      )
        return null;
    }
    const decoder = sharp(input, { limitInputPixels: 16_000_000, animated: false });
    const info = await decoder.metadata();
    if (!['png', 'jpeg', 'webp', 'svg', 'gif'].includes(info.format ?? '')) return null;
    const png = await decoder
      .rotate()
      .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return png.length <= 220_000 ? `data:image/png;base64,${png.toString('base64')}` : null;
  } catch {
    return null;
  }
}
function links(html: string): { rel: string; href: string }[] {
  return (html.match(/<link\b[^>]{0,4096}>/gi) ?? []).slice(0, 64).flatMap((tag) => {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/\b(rel|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
      attrs[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&');
    return attrs.rel && attrs.href ? [{ rel: attrs.rel, href: attrs.href }] : [];
  });
}
const monorepoIcons = ['apps/desktop/resources/icon.png', 'apps/mobile/assets/icon.png'];

function linkedPackageDirectories(readme: Buffer | null): string[] {
  const roots = new Set<string>();
  const markdown = readme?.subarray(0, 32 * 1024).toString('utf8') ?? '';
  for (const link of markdown.matchAll(
    /(?<!!)\[[^\]\n]{1,256}\]\((?:<([^>\n]{1,1024})>|([^\s()]{1,1024}))\)/g,
  )) {
    let target: string;
    try {
      target = decodeURIComponent((link[1] ?? link[2]!).split('#')[0]!);
    } catch {
      continue;
    }
    if (!target || target.startsWith('/') || target.split('/').includes('..')) continue;
    const relative = localIconPath(target);
    if (!relative) continue;
    const directory = /\/(?:README\.md|package\.json)$/i.test(relative)
      ? path.posix.dirname(relative)
      : relative.replace(/\/$/, '');
    // Whether a link names a package is determined by its manifest, not a filename suffix.
    if (!directory || directory === '.') continue;
    roots.add(directory);
    if (roots.size === 8) break;
  }
  return [...roots];
}

interface IconPackage {
  name?: string;
  build?: { icon?: unknown; mac?: { icon?: unknown } };
}

async function localArtwork(
  read: IconDiscoveryIO['read'],
  root: string,
  pkg: IconPackage | null,
  app: { expo?: { icon?: unknown }; icon?: unknown } | null,
): Promise<DiscoveredProjectIcon | null> {
  const paths: string[] = [];
  for (const p of [app?.expo?.icon, app?.icon, pkg?.build?.icon, pkg?.build?.mac?.icon]) {
    const valid = localIconPath(p);
    if (valid) paths.push(valid);
  }
  for (const name of [
    'manifest.webmanifest',
    'manifest.json',
    'public/manifest.webmanifest',
    'public/manifest.json',
  ]) {
    const manifest = json(await read(root + name));
    if (Array.isArray(manifest?.icons))
      for (const icon of manifest.icons.slice(0, 6)) {
        const p = localIconPath(icon?.src, path.posix.dirname(name));
        if (p) paths.push(p);
      }
  }
  paths.push(
    'public/apple-touch-icon.png',
    'public/icon.png',
    'public/favicon.png',
    'public/favicon.svg',
    'app/icon.png',
    'src/app/icon.png',
    'assets/icon.png',
    'assets/images/icon.png',
    'resources/icon.png',
    'build/icon.png',
    'icon.png',
    'favicon.png',
    'favicon.svg',
    'public/favicon.ico',
    'favicon.ico',
  );
  for (const relative of [...new Set(paths)].slice(0, 28).concat(monorepoIcons)) {
    const source = root + relative;
    const bytes = await read(source);
    const image = bytes && (await projectIconThumbnail(bytes));
    if (image) return { image, source, kind: 'local', candidate: false };
  }
  return null;
}

export async function discoverProjectIcon(
  io: IconDiscoveryIO,
): Promise<DiscoveredProjectIcon | null> {
  const read = (p: string) => io.read(p).catch(() => null);
  const fetch = (u: string) => io.fetch(u).catch(() => null);
  const pkg = json(await read('package.json'));
  const app = json(await read('app.json'));
  const local = await localArtwork(read, '', pkg, app);
  if (local) return local;
  const website = async (raw: unknown): Promise<DiscoveredProjectIcon | null> => {
    const url = safeIconUrl(raw);
    if (!url || ['github.com', 'www.github.com', 'api.github.com'].includes(new URL(url).hostname))
      return null;
    const page = await fetch(url);
    if (!page) return null;
    const declared = links(page.bytes.toString('utf8'));
    const urls = declared
      .filter((l) => /^(?:apple-touch-icon(?:-precomposed)?|(?:shortcut\s+)?icon)$/i.test(l.rel))
      .map((l) => safeIconUrl(l.href, page.url))
      .filter((x): x is string => !!x)
      .slice(0, 4);
    const manifestLink = declared.find((l) => l.rel.toLowerCase() === 'manifest');
    const manifestUrl = manifestLink && safeIconUrl(manifestLink.href, page.url);
    if (manifestUrl) {
      const manifest = json((await fetch(manifestUrl))?.bytes ?? null);
      if (Array.isArray(manifest?.icons))
        for (const icon of manifest.icons.slice(0, 3)) {
          const u = safeIconUrl(icon?.src, manifestUrl);
          if (u) urls.push(u);
        }
    }
    urls.push(
      new URL('/apple-touch-icon.png', page.url).href,
      new URL('/favicon.ico', page.url).href,
    );
    for (const u of [...new Set(urls)].slice(0, 8)) {
      const result = await fetch(u);
      const image = result && (await projectIconThumbnail(result.bytes));
      if (image)
        return { image, source: new URL(page.url).origin, kind: 'website', candidate: false };
    }
    return null;
  };
  const ownWebsite = await website(pkg?.homepage);
  if (ownWebsite) return ownWebsite;
  const origin =
    (await io.gitOrigin?.().catch(() => null)) ??
    (await read('.git/config'))?.toString('utf8') ??
    '';
  const repo = [typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url, origin]
    .filter((x) => typeof x === 'string')
    .map((x) => x.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i))
    .find(Boolean);
  if (!repo) {
    const name = io.directoryName?.toLowerCase();
    if (pkg || app || !name) return null;
    let match: { root: string; pkg: IconPackage } | undefined;
    for (const root of linkedPackageDirectories(await read('README.md'))) {
      const child = json(await read(`${root}/package.json`));
      if (typeof child?.name !== 'string' || child.name.split('/').pop()?.toLowerCase() !== name)
        continue;
      // A README may link several checkouts of the same package. Avoid choosing by link order.
      if (match) return null;
      match = { root, pkg: child };
    }
    if (!match) return null;
    const root = match.root + '/';
    return localArtwork(read, root, match.pkg, json(await read(root + 'app.json')));
  }
  const slug = `${repo[1]}/${repo[2]!.replace(/\.git$/, '')}`;
  const meta = json((await fetch(`https://api.github.com/repos/${slug}`))?.bytes ?? null);
  const site = await website(meta?.homepage);
  if (site) return site;
  // An account avatar is offered explicitly, never silently used for all repositories.
  const avatar = safeIconUrl(meta?.owner?.avatar_url);
  if (avatar) {
    const result = await fetch(avatar);
    const image = result && (await projectIconThumbnail(result.bytes));
    if (image)
      return { image, source: `https://github.com/${repo[1]}`, kind: 'github', candidate: true };
  }
  return null;
}
