import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
vi.mock("@/config/env", () => ({ getActiveMobileSessionRealm: () => 'global' }));
const disk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  copying: false,
  gate: undefined as Promise<void> | undefined,
  seq: 0,
  available: 10 * 1024 ** 3,
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async (_algorithm: string, text: string) =>
    createHash("sha256").update(text).digest("hex"),
  randomUUID: () => `copy-${++disk.seq}`,
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache", get availableDiskSpace() { return disk.available; } },
  Directory: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((p) => (typeof p === "string" ? p : p.uri))
        .join("/");
    }
    create() {}
    list() {
      return [...disk.files.keys()]
        .filter((uri) => uri.startsWith(`${this.uri}/`))
        .map((uri) => new File(uri));
    }
  },
  File: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts
        .map((p) => (typeof p === "string" ? p : p.uri))
        .join("/");
    }
    static async downloadFileAsync(url: string, target: { uri: string }) {
      const bytes = disk.files.get(url);
      if (!bytes) throw new Error("missing");
      disk.files.set(target.uri, bytes.slice());
      return new File(target.uri);
    }
    get exists() {
      return disk.files.has(this.uri);
    }
    get name() { return this.uri.split('/').at(-1)!; }
    moveSync(target: { uri: string }) {
      const bytes = disk.files.get(this.uri);
      if (!bytes) throw new Error('missing');
      disk.files.set(target.uri, bytes);
      disk.files.delete(this.uri);
      this.uri = target.uri;
    }
    get size() {
      return disk.files.get(this.uri)?.length ?? 0;
    }
    delete() {
      disk.files.delete(this.uri);
    }
    async base64() { return Buffer.from(disk.files.get(this.uri)!).toString('base64'); }
    async text() { return new TextDecoder().decode(disk.files.get(this.uri)); }
    write(value: string | Uint8Array) { disk.files.set(this.uri, typeof value === "string" ? new TextEncoder().encode(value) : value); }
    async copy(target: { uri: string }) {
      disk.copying = true;
      if (disk.gate) await disk.gate;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const bytes = disk.files.get(this.uri);
      if (!bytes) throw new Error("missing");
      disk.files.set(target.uri, bytes.slice());
      disk.copying = false;
    }
  },
}));
vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: async (uri: string, options: { position: number; length: number }) =>
    Buffer.from(disk.files.get(uri)!).subarray(options.position, options.position + options.length).toString('base64'),
  createDownloadResumable: (url: string, uri: string) => ({
    downloadAsync: async () => { disk.files.set(uri, disk.files.get(url)!.slice()); return { uri, status: 200 }; },
    cancelAsync: async () => {},
  }),
  deleteAsync: async (uri: string) => { disk.files.delete(uri); },
}));
import { createRemoteMediaDiskCache } from '@/session/remoteMediaDiskCache';
import { createExpoRemoteMediaDiskCacheIO } from '@/session/remoteMediaDiskCacheExpo';
import { createPeerFileCache } from "@/device-link/peerFileCache";
import { createMobileHtmlPreviewCache } from '@/session/mobileHtmlPreviewCache';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { File } from 'expo-file-system';
import { FILE_PEER_MAX_BYTES, sharedTaskHostPeer } from '@cindy/device-link';
import { remoteFileMediaUrl } from '@/session/fileBrowserGallery';
import {
  clearPeerMedia,
  peerMediaUri,
  recordPeerMedia,
  releasePeerMedia,
} from "@/device-link/peerFileRegistry";
afterEach(() => {
  setMobileAuthOwner(null);
  clearPeerMedia();
  disk.gate = undefined;
  disk.copying = false;
  disk.available = 10 * 1024 ** 3;
});

// Cached previews have no fresh metadata: identity and owner fencing must hold locally.
it('restores preview bytes offline, isolates account/device/SSH, and rejects a copy crossing an account switch', async () => {
  setMobileAuthOwner('html-owner');
  // Shared guests must revalidate membership before reading, including HTML.
  expect(createMobileHtmlPreviewCache(sharedTaskHostPeer('shared', 'host'), '/site')).toBeUndefined();
  const cache = createMobileHtmlPreviewCache('desktop-a', '/site')!;
  const input = new File('file:///input.html');
  input.write('<p>Cached</p>');
  // A transfer saved before cache-first previews existed must also open offline.
  const transfer = await createPeerFileCache(JSON.stringify(['global', 'html-owner']));
  const meta = { ...metadata, size: input.size };
  const media = { ossKey: '', ...meta };
  recordPeerMedia(media, input.uri, () => {});
  await transfer.store('desktop-a', remoteFileMediaUrl('/site/index.html', undefined, undefined,
    { baseDir: '/site', maxBytes: FILE_PEER_MAX_BYTES }), meta, media);
  const copy = new File('file:///restored.html');
  expect(await cache.copy('index.html', copy)).toBe(input.size);
  expect(await copy.text()).toBe('<p>Cached</p>');
  expect(await cache.copy('index.html', new File('file:///too-large.html'), 1)).toBeNull();
  expect(disk.files.has('file:///too-large.html')).toBe(false);
  await cache.store('index.html', input, 'text/html');
  expect(await createMobileHtmlPreviewCache('desktop-b', '/site')!.copy('index.html', copy)).toBeNull();
  const ssh = { sessionId: 's', remoteHostId: 'ssh', workdir: '/site' };
  expect(await createMobileHtmlPreviewCache('desktop-a', '/site', ssh)!.copy('index.html', copy)).toBeNull();
  setMobileAuthOwner('other-html-owner');
  expect(await createMobileHtmlPreviewCache('desktop-a', '/site')!.copy('index.html', copy)).toBeNull();
  setMobileAuthOwner('html-owner');
  const restored = createMobileHtmlPreviewCache('desktop-a', '/site')!;
  let release!: () => void;
  disk.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = restored.copy('index.html', copy);
  await vi.waitFor(() => expect(disk.copying).toBe(true));
  setMobileAuthOwner('other-html-owner');
  release();
  expect(await pending).toBeNull();
  expect(copy.exists).toBe(false);
});

it('restores complete legacy manifests and rejects paths that the preview cannot publish', async () => {
  setMobileAuthOwner('manifest-owner');
  const cache = createMobileHtmlPreviewCache('desktop', '/site')!;
  const temporary = new File('file:///manifest.json');
  const file = { name: 'index.html', relPath: 'index.html', type: 'file' as const, size: 20 };
  await cache.storeManifest('index.html', [file], temporary);
  expect(await cache.manifest('index.html')).toEqual([file]);
  expect(temporary.exists).toBe(false);
  await cache.storeManifest('index.html', [file, { ...file, relPath: '../secret.html' }], temporary);
  expect(await cache.manifest('index.html')).toBeNull();
});
const metadata = { size: 5, mimeType: "text/html", version: "a".repeat(64) };
it('reuses completed OSS downloads through the same cache and does not retain changed-sized bytes', async () => {
  const cache = await createPeerFileCache('oss-owner');
  disk.files.set('https://oss/file', new Uint8Array(5));
  const result = await cache.download('device', 'url', metadata, 'https://oss/file', () => true);
  expect(result).not.toBeNull();
  releasePeerMedia(peerMediaUri(result!)!);
  expect(await cache.read('device', 'url', metadata, () => true)).not.toBeNull();
  expect(await cache.download('device', 'changed', { ...metadata, size: 6 }, 'https://oss/file', () => true)).toBeNull();
  expect(await cache.read('device', 'changed', metadata, () => true)).toBeNull();
});
it.each([0, 5])('shares %s-byte inline files with the durable version cache', async size => {
  const cache = await createPeerFileCache(`inline-${size}`);
  const result = { ossKey: '', ...metadata, size, inlineBase64: Buffer.alloc(size, 7).toString('base64') };
  await cache.storeInline('device', 'url', result);
  expect(await cache.readLatest('device', 'url', () => true)).toEqual(result);
  expect(await cache.readInline('device', 'url', result, () => true)).toEqual(result);
  expect(await cache.readInline('other-device', 'url', result, () => true)).toBeNull();
  expect(await cache.readInline('device', 'url', { ...result, version: 'b'.repeat(64) }, () => true)).toBeNull();
  expect(await cache.readLatest('device', 'url', () => true)).toEqual(result);
});
// PR #6299: the mocked cache IO hid empty-file rejection. Exercise the real cache
// and Expo adapter with an in-memory filesystem (unit): empty first writes and
// nonempty -> empty refresh must survive an index reload and shadow old transfers.
it.each(['', '<p>Old</p>'])('persists empty preview files after initial content %j', async (initial) => {
  const account = `empty-preview-${initial.length}`;
  const owner = JSON.stringify(['global', account]);
  setMobileAuthOwner(account);
  const cache = createMobileHtmlPreviewCache('desktop', '/site')!;
  const source = new File(`file:///input-${account}.html`);
  const destination = new File(`file:///output-${account}.html`);
  source.write('<p>Old transfer</p>');
  const transfer = await createPeerFileCache(owner);
  const meta = { ...metadata, size: source.size };
  const media = { ossKey: '', ...meta };
  recordPeerMedia(media, source.uri, () => {});
  await transfer.store('desktop', remoteFileMediaUrl('/site/index.html', undefined, undefined,
    { baseDir: '/site', maxBytes: FILE_PEER_MAX_BYTES }), meta, media);
  source.write(initial);
  await cache.store('index.html', source, 'text/html');
  source.write('');
  await cache.store('index.html', source, 'text/html');
  expect(await cache.copy('index.html', destination)).toBe(0);
  expect(await destination.text()).toBe('');
  const namespace = `files-${createHash('sha256').update(owner).digest('hex')}`;
  const reopened = createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO(namespace));
  const identity = JSON.stringify(['desktop', null, '/site', 'resource', 'index.html']);
  const hit = await reopened.lookup(`html-preview:${identity}`);
  expect(hit?.size).toBe(0);
  expect(await new File(hit!.uri).text()).toBe('');
});
async function seed(owner: string) {
  const cache = await createPeerFileCache(owner);
  const uri = `file:///received/${owner}`;
  disk.files.set(uri, Uint8Array.from([1, 2, 3, 4, 5]));
  const media = { ossKey: "", ...metadata };
  recordPeerMedia(media, uri, () => {
    disk.files.delete(uri);
  });
  await cache.store("device", "url", metadata, media);
  releasePeerMedia(uri);
  return cache;
}
it("awaits the asynchronous copy before returning, and consumer disposal leaves the durable copy intact", async () => {
  const cache = await seed("copy-owner");
  const result = await cache.read("device", "url", metadata, () => true);
  const uri = peerMediaUri(result!)!;
  expect(disk.files.get(uri)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
  expect(disk.copying).toBe(false);
  releasePeerMedia(uri);
  expect(
    await cache.read("device", "url", metadata, () => true),
  ).not.toBeNull();
  const other = await createPeerFileCache("other-owner");
  expect(await other.read("device", "url", metadata, () => true)).toBeNull();
});
it("discards a copy completed after cancellation and retains only the reusable source", async () => {
  const cache = await seed("cancel-owner");
  let resume!: () => void,
    active = true;
  disk.gate = new Promise((resolve) => {
    resume = resolve;
  });
  const before = new Set(disk.files.keys());
  const read = cache.read("device", "url", metadata, () => active);
  await vi.waitFor(() => expect(disk.copying).toBe(true));
  active = false;
  resume();
  expect(await read).toBeNull();
  expect(new Set(disk.files.keys())).toEqual(before);
});
it("invalidates a bad cache even if the forced transfer later fails, while consumer copies survive", async () => {
  const cache = await seed("refresh-owner");
  const old = await cache.read("device", "url", metadata, () => true);
  const uri = peerMediaUri(old!)!;
  await cache.invalidate("device", "url");
  expect(await cache.read("device", "url", metadata, () => true)).toBeNull();
  expect(disk.files.get(uri)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
});

it("reserves only one copy on a hit and preserves its source when space cannot be reclaimed", async () => {
  const cache = await seed("pressure-owner");
  const before = new Set(disk.files.keys());
  const reserve = 256 * 1024 ** 2;
  disk.available = reserve + metadata.size - 1;
  expect(await cache.read("device", "url", metadata, () => true)).toBeNull();
  expect(new Set(disk.files.keys())).toEqual(before);
  disk.available = reserve + metadata.size;
  const result = await cache.read("device", "url", metadata, () => true);
  expect(result).not.toBeNull();
  releasePeerMedia(peerMediaUri(result!)!);
  expect(new Set(disk.files.keys())).toEqual(before);
});

it.each(['download', 'store', 'direct'] as const)('keeps the old version when %s cannot reserve replacement space', async mode => {
  const cache = await seed(`replace-pressure-${mode}`);
  const before = new Set(disk.files.keys());
  const newer = { ...metadata, version: 'b'.repeat(64) };
  disk.available = 256 * 1024 ** 2 + metadata.size - 1;
  if (mode === 'download') {
    expect(await cache.download('device', 'url', newer, 'https://unavailable', () => true)).toBeNull();
  } else if (mode === 'direct') {
    expect(await cache.prune('device', 'url', newer.size)).toBe(false);
  } else {
    const uri = 'file:///replacement';
    disk.files.set(uri, new Uint8Array(newer.size));
    const result = { ossKey: '', ...newer };
    recordPeerMedia(result, uri, () => disk.files.delete(uri));
    await cache.store('device', 'url', newer, result);
    releasePeerMedia(uri);
  }
  expect(new Set(disk.files.keys())).toEqual(before);
  expect(await cache.readLatest('device', 'url', () => true)).toMatchObject(metadata);
});

// Companion icons used to bypass the disk cache entirely. Verify real bytes survive
// opening a new index reader, and account/device/content identities remain separate (unit).
it('persists avatar bytes in the existing account cache and reads them without a download', async () => {
  const owner = JSON.stringify(['global', 'avatar-owner']);
  const identity = JSON.stringify(['mac', 'cindy-media://blobs/avatar.png']);
  const source = 'file:///fixture-avatar.png';
  disk.files.set(source, new Uint8Array([1, 2, 3, 4]));
  const cache = await createPeerFileCache(owner);
  expect(await cache.storeAvatar(identity, source, 'image/png', () => true)).toBe(true);
  disk.files.delete(source);
  const namespace = `files-${createHash('sha256').update(owner).digest('hex')}`;
  const reopened = createRemoteMediaDiskCache(createExpoRemoteMediaDiskCacheIO(namespace));
  const hit = await reopened.lookup(`companion-avatar:${identity}`);
  expect(hit?.size).toBe(4);
  expect(await new File(hit!.uri).base64()).toBe('AQIDBA==');
  expect((await cache.lookupAvatar(identity))?.uri).toBe(hit!.uri);
  expect(await cache.lookupAvatar(JSON.stringify(['other-mac', 'cindy-media://blobs/avatar.png']))).toBeNull();
  expect(await (await createPeerFileCache('different-avatar-owner')).lookupAvatar(identity)).toBeNull();
  disk.files.set(source, new Uint8Array([5]));
  expect(await cache.storeAvatar('cancelled', source, 'image/png', () => false)).toBe(false);
  expect(await cache.lookupAvatar('cancelled')).toBeNull();
});

// Review regression (unit): a public endpoint may return HTTP 200 with an HTML
// error page. Real cache + download adapter must reject it and allow later recovery.
it('rejects non-image avatar responses and persists recovered image bytes using their actual MIME', async () => {
  const cache = await createPeerFileCache('avatar-response-owner');
  const url = 'https://avatars.example.invalid/profile';
  disk.files.set(url, new TextEncoder().encode('<html>Temporary outage</html>'));
  expect(await cache.storeAvatar(url, url, 'image/png', () => true)).toBe(false);
  expect(await cache.lookupAvatar(url)).toBeNull();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  disk.files.set(url, jpeg);
  expect(await cache.storeAvatar(url, url, 'image/png', () => true)).toBe(true);
  const hit = await cache.lookupAvatar(url);
  expect(hit?.mimeType).toBe('image/jpeg');
  expect(await new File(hit!.uri).base64()).toBe(Buffer.from(jpeg).toString('base64'));
  expect([...disk.files.keys()].filter(uri => uri.includes('/remote-media-share/'))).toEqual([]);
});
