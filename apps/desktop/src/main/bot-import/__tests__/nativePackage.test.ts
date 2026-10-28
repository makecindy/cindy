import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { sniffImageMime } from '../../lightboxMediaActions.js';
import { toSdrAvatarImage } from '../../hdrAvatarToSdr.js';
import { BOT_PACKAGE_IDS, BOT_PACKAGE_VERSION, applyNativeLocale, canonicalPackageJson, readNativeBotPackage } from '../nativePackage.js';
const root = path.resolve('resources/bot-packages');
const version = BOT_PACKAGE_VERSION;
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-package-test-')); temporary.push(dir);
  await fs.cp(path.join(root, 'engineer-bot'), path.join(dir, 'engineer-bot'), { recursive: true });
  return dir;
}
it('loads all ten immutable recipes with complete skills, knowledge, portraits, and disabled routines', async () => {
  let skills = 0, scripts = 0, routines = 0;
  for (const id of BOT_PACKAGE_IDS) {
    const pkg = await readNativeBotPackage(root, id);
    const manifest = JSON.parse(await fs.readFile(path.join(root, id, version, 'manifest.json'), 'utf8'));
    expect(pkg.identity.packageHash).toBe(createHash('sha256').update(canonicalPackageJson(manifest)).digest('hex'));
    expect('author' in pkg.entry).toBe(false);
    // The detail-page bubble is authored per language and travels with the catalog entry.
    expect(pkg.entry.bubble).toBe(manifest.presentation.bubbleZh);
    for (const [locale, copy] of Object.entries(pkg.entry.locales)) expect(copy.bubble, `${id}: ${locale}`).toBe(manifest.presentation.i18n[locale].bubble);
    // Chinese is the base copy and every language carries its own authored name.
    expect(pkg.entry.name).toBe(manifest.presentation.displayNameZh);
    for (const [locale, copy] of Object.entries(pkg.entry.locales)) expect(copy.name, `${id}: ${locale}`).toBe(manifest.presentation.i18n[locale].displayName);
    expect(pkg.entry.avatar.startsWith('data:image/webp;base64,')).toBe(true);
    expect(pkg.entry.capabilities).toHaveLength(3);
    expect(pkg.entry.welcome).toBe(manifest.firstUse.welcome);
    // The opening travels with the import so the greeting and onboarding Skill come from this package.
    expect(pkg.snapshot.nativePackage?.opening).toEqual({ welcome: manifest.firstUse.welcome,
      capabilities: manifest.presentation.capabilitiesZh.map((item: { label: string }) => item.label), onboardingSkill: `${id}-getting-started`, starterOptions: expect.any(Array) });
    expect(pkg.snapshot.items.some(item => item.view.name === `${id}-getting-started` && item.files?.some(file => file.name === 'SKILL.md'))).toBe(true);
    // Every import entry has a display name, so a partial save can say which item failed.
    for (const item of pkg.snapshot.items) expect(pkg.entry.itemNames[item.view.id]).toBeTruthy();
    expect(pkg.snapshot.items.filter(item => item.automation).every(item => pkg.entry.itemNames[item.view.id] === item.view.name)).toBe(true);
    // The opening shows the Skill's own starter list, so the Skill must list the same options the host shows.
    const onboarding = await fs.readFile(path.join(root, id, version, 'skills', `${id}-getting-started`, 'SKILL.md'), 'utf8');
    const options = pkg.snapshot.nativePackage?.opening?.starterOptions ?? [];
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(options.length).toBeLessThanOrEqual(4);
    for (const option of options) expect(onboarding).toContain(`- ${option}`);
    expect(pkg.snapshot.source.kind).toBe('cindy');
    expect(pkg.snapshot.items.some(item => item.role === 'user' || item.role === 'instructions' || item.env || item.credential)).toBe(false);
    for (const item of pkg.snapshot.items) {
      if (item.files) {
        skills++; expect(item.files.some(file => file.name === 'SKILL.md')).toBe(true);
        for (const file of item.files) {
          expect(file.bytes.equals(await fs.readFile(path.join(root, id, version, 'skills', item.view.name, file.name)))).toBe(true);
          expect(file.executable).toBe(false);
          if (file.name.endsWith('.py')) scripts++;
        }
      }
      if (item.automation) { routines++; expect(item.automation.input?.enabled).toBe(false); expect(item.view.enabled).toBe(false); }
    }
  }
  expect({ skills, scripts, routines }).toEqual({ skills: 30, scripts: 10, routines: 18 });
});
it('keeps the source schedule shape: three Cooper routines, the engineering PR watch and the three SEO & AEO Desk routines', async () => {
  const cron = async (id: string) => (await readNativeBotPackage(root, id)).snapshot.items.flatMap(item => item.automation
    ? (item.automation.input?.triggers ?? []).map(trigger => trigger.kind === 'cron' ? trigger.expression : '') : []);
  expect(await cron('cooper')).toEqual(['0 8 * * *', '0 13 * * 1-5', '0 16 * * 1-5']);
  expect(await cron('engineer-bot')).toEqual(['0,30 * * * *']);
  expect(await cron('seo-aeo-desk')).toEqual(['0 9 * * 3', '0 9 * * 1', '0 8 * * 1-5']);
});
it('uses the offline creator canonical UTF-8 hashing algorithm', () => {
  expect(canonicalPackageJson({ z: ['中文', 1], a: { y: true, b: null } })).toBe('{"a":{"b":null,"y":true},"z":["中文",1]}');
});
it.each(['../engineer-bot', '/tmp/package', 'unknown'])('refuses arbitrary package references: %s', async id => {
  await expect(readNativeBotPackage(root, id)).rejects.toThrow('INVALID_PACKAGE');
});
it('rejects modified bytes before exposing a catalog entry or import snapshot', async () => {
  const dir = await fixture();
  await fs.appendFile(path.join(dir, 'engineer-bot', version, 'knowledge/method.md'), 'tampered');
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('rejects unbound extra files, even in a skill subtree', async () => {
  const dir = await fixture();
  await fs.writeFile(path.join(dir, 'engineer-bot', version, 'skills/engineer-bot-ops/extra.py'), 'pass');
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('refuses symlinks rather than following package paths outside the trusted directory', async () => {
  const dir = await fixture();
  // Unit: exercise the same lstat rejection with an unprivileged Windows junction,
  // as in files.test.ts, rather than failing to create the fixture before validation.
  const relative = process.platform === 'win32' ? 'knowledge' : path.join('knowledge', 'method.md');
  const link = path.join(dir, 'engineer-bot', version, relative);
  await fs.rm(link, { recursive: true });
  await fs.symlink(path.join(root, 'engineer-bot', version, relative), link,
    process.platform === 'win32' ? 'junction' : 'file');
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('rejects capability icons outside the shared whitelist', async () => {
  const dir = await fixture();
  const file = path.join(dir, 'engineer-bot', version, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.presentation.capabilitiesZh[0].icon = 'rocket';
  await fs.writeFile(file, JSON.stringify(manifest));
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('rejects an onboarding Skill reference that the package does not ship', async () => {
  const dir = await fixture();
  const file = path.join(dir, 'engineer-bot', version, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.firstUse.onboardingSkill = 'missing-getting-started';
  await fs.writeFile(file, JSON.stringify(manifest));
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('reads the detail page fields from the authored detailZh copy, not from Skill or routine text', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'cooper', version, 'manifest.json'), 'utf8'));
  const detail = manifest.presentation.detailZh;
  type Titled = { title: string; summary: string };
  const cooper = (await readNativeBotPackage(root, 'cooper')).entry;
  // The onboarding Skill is the host's opening pipeline (the greeting bubble), so the page lists only the other Skills.
  expect(cooper.skills).toEqual(detail.skills.map(({ title, summary }: Titled) => ({ name: title, description: summary })));
  expect(cooper.knowledge).toEqual(detail.memory.knowledge.map(({ title, summary }: Titled) => ({ title, summary })));
  expect(cooper.remembers).toEqual(detail.memory.remembers);
  expect(cooper.tools).toEqual(detail.tools.map(({ ref, purpose }: { ref: string; purpose: string }) => ({ id: ref, purpose })));
  expect(cooper.routines.map(({ name, summary }) => ({ name, summary }))).toEqual(detail.routines.map(({ title, summary }: Titled) => ({ name: title, summary })));
  expect(cooper.routines.map(routine => routine.cron)).toEqual(['0 8 * * *', '0 13 * * 1-5', '0 16 * * 1-5']);
  expect((await readNativeBotPackage(root, 'engineer-bot')).entry.routines[0]!.cron).toBe('0,30 * * * *');
});
it('ships authored copy within the field limits for all ten packages, with public-market plugins only', async () => {
  const wording = /配方|本包|离线示例|UTC|原作者|USER\.md|脚本|\.py\b|水位|游标|字段名/;
  // Public-market plugins only (never organisation-only xd-* ones); the page lists representative ones, teammates use whatever the user has.
  const publicPlugins = new Set(['cindy-github', 'cindy-gitlab', 'cindy-notion', 'google-sheets', 'google-gmail', 'outlook-mail', 'google-drive',
    'cindy-web-search', 'x-manager', 'cindy-art', 'opendesign-trial', 'baguette-simulator']);
  const shape: Record<string, number[]> = {};
  for (const id of BOT_PACKAGE_IDS) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, id, version, 'manifest.json'), 'utf8'));
    const entry = (await readNativeBotPackage(root, id)).entry;
    for (const skill of entry.skills) { expect(skill.name.length).toBeLessThanOrEqual(12); expect(skill.description.length).toBeLessThanOrEqual(48); }
    for (const reference of entry.knowledge) { expect(reference.title.length).toBeLessThanOrEqual(12); expect(reference.summary.length).toBeLessThanOrEqual(60); }
    for (const routine of entry.routines) { expect(routine.name.length).toBeLessThanOrEqual(12); expect(routine.summary.length).toBeLessThanOrEqual(40); }
    expect(entry.remembers.length).toBeLessThanOrEqual(8);
    for (const item of entry.remembers) expect(item.length).toBeLessThanOrEqual(10);
    // The bubble is one short line (zh ≤ 20), never a greeting.
    expect(entry.bubble.length).toBeLessThanOrEqual(20);
    expect(entry.bubble).not.toMatch(/你好|您好|Hello|Hi\b/);
    const shown = [...entry.skills.flatMap(skill => [skill.name, skill.description]), ...entry.knowledge.flatMap(reference => [reference.title, reference.summary]),
      ...entry.remembers, ...entry.tools.map(tool => tool.purpose), ...entry.routines.flatMap(routine => [routine.name, routine.summary])];
    for (const text of shown) expect(text, `${id}: ${text}`).not.toMatch(wording);
    // Authored copy covers every non-onboarding Skill, every plugin dependency and every routine of the manifest.
    expect(entry.skills).toHaveLength(manifest.skills.length - 1);
    expect(entry.tools.map(tool => tool.id)).toEqual(manifest.dependencies.plugins.map((plugin: { id: string }) => plugin.id));
    for (const tool of entry.tools) expect(publicPlugins.has(tool.id), `${id}: ${tool.id}`).toBe(true);
    expect(entry.routines).toHaveLength(manifest.routines.length);
    expect(manifest.presentation.cases).toEqual([]);
    expect(manifest.profile.avatar.path).toBe('assets/avatar.webp');
    expect(entry.knowledge.length).toBeGreaterThan(0);
    expect(entry.remembers.length).toBeGreaterThan(0);
    shape[id] = [entry.skills.length, entry.knowledge.length, entry.remembers.length, entry.tools.length, entry.routines.length];
  }
  // [skills, knowledge, remembers, tools, routines] per package.
  expect(shape).toEqual({
    'cooper': [2, 1, 6, 2, 3], 'engineer-bot': [2, 1, 7, 3, 1], 'nightly-audit-engineer': [2, 1, 6, 2, 1], 'proto-bot': [2, 1, 5, 4, 2],
    'seo-aeo-desk': [2, 1, 8, 3, 3], 'startup-qa-bot': [2, 1, 7, 3, 1], 'video-editor': [2, 1, 7, 2, 0],
    'ad-spend-watch': [2, 1, 8, 3, 3], 'apple-search-ads-review': [2, 1, 8, 3, 2], 'sable-game-art': [2, 1, 8, 4, 2],
  });
});
interface Detail { skills: Array<{ ref: string; title: string; summary: string }>; memory: { knowledge: unknown[]; remembers: string[] };
  tools: Array<{ ref: string }>; routines: Array<{ icon?: string; extra?: unknown }>; extra?: unknown[] }
interface I18nBlock { displayName: string; valueDescription: string; capabilities: string[]; welcome: string; starterOptions: string[]; bubble: string; detail: Detail }
interface Manifest { presentation: { detailZh: Detail; starterOptionsZh: string[]; bubbleZh: string; i18n: Record<string, I18nBlock> } }
async function edit(id: string, change: (manifest: Manifest) => void) {
  const dir = await fixture();
  const file = path.join(dir, id, version, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
  change(manifest);
  await fs.writeFile(file, JSON.stringify(manifest));
  return dir;
}
it.each([
  ['an unknown Skill ref', (m: Manifest) => { m.presentation.detailZh.skills[0]!.ref = 'missing-skill'; }],
  ['a Skill left out of the copy', (m: Manifest) => { m.presentation.detailZh.skills.pop(); }],
  ['a title over 12 characters', (m: Manifest) => { m.presentation.detailZh.skills[0]!.title = '一二三四五六七八九十一二三'; }],
  ['a summary over 48 characters', (m: Manifest) => { m.presentation.detailZh.skills[0]!.summary = '字'.repeat(49); }],
  ['a tool ref that is not a dependency', (m: Manifest) => { m.presentation.detailZh.tools[0]!.ref = 'xd-feishu'; }],
  ['an unknown extra routine field', (m: Manifest) => { m.presentation.detailZh.routines[0]!.extra = 1; }],
  ['more than eight remembered preferences', (m: Manifest) => { m.presentation.detailZh.memory.remembers = Array.from({ length: 9 }, (_, i) => `偏好${i}`); }],
  ['an unknown extra field', (m: Manifest) => { m.presentation.detailZh.extra = []; }],
])('rejects detail copy with %s', async (_label, change) => {
  const dir = await edit('engineer-bot', change);
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('refuses a routine icon in the detail copy: routine rows carry no icon field in the package contract', async () => {
  const original = await readNativeBotPackage(root, 'engineer-bot');
  expect(original.entry.routines.every(routine => !('icon' in routine))).toBe(true);
  for (const copy of Object.values(original.entry.locales)) expect(copy.routines.every(routine => !('icon' in routine))).toBe(true);
  await expect(readNativeBotPackage(await edit('engineer-bot', m => { m.presentation.detailZh.routines[0]!.icon = 'check'; }), 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
  await expect(readNativeBotPackage(await edit('engineer-bot', m => { m.presentation.i18n.en!.detail.routines[0]!.icon = 'check'; }), 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it.each([
  ['a language block without the bubble', (m: Manifest) => { Reflect.deleteProperty(m.presentation.i18n.ja!, 'bubble'); }],
  ['a bubble over the length limit', (m: Manifest) => { m.presentation.bubbleZh = '字'.repeat(21); }],
  ['an English bubble over the length limit', (m: Manifest) => { m.presentation.i18n.en!.bubble = 'x'.repeat(61); }],
  ['an empty bubble', (m: Manifest) => { m.presentation.bubbleZh = ''; }],
])('rejects a package with %s', async (_label, change) => {
  await expect(readNativeBotPackage(await edit('engineer-bot', change), 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
const missingFields: Array<[string, (m: Manifest) => void]> = [
  ['detailZh', m => { Reflect.deleteProperty(m.presentation, 'detailZh'); }],
  ['bubbleZh', m => { Reflect.deleteProperty(m.presentation, 'bubbleZh'); }],
  ['starterOptionsZh', m => { Reflect.deleteProperty(m.presentation, 'starterOptionsZh'); }],
  ['i18n', m => { Reflect.deleteProperty(m.presentation, 'i18n'); }],
  ...['en', 'ja', 'ko', 'zh-TW'].map((locale): [string, (m: Manifest) => void] => [`the ${locale} copy`, m => { Reflect.deleteProperty(m.presentation.i18n, locale); }]),
];
it.each(missingFields)('rejects a package without %s', async (_label, change) => {
  await expect(readNativeBotPackage(await edit('engineer-bot', change), 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
async function shippedAvatar(id: string) { return fs.readFile(path.join(root, id, version, 'assets/avatar.webp')); }
it.each([
  ['PNG', async () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQaSoDAAHqAR23XEz0AAAAAElFTkSuQmCC', 'base64')],
  ['GIF', async () => Buffer.from('GIF89a------')],
  ['JPEG', async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])],
  ['truncated WebP', async () => (await shippedAvatar('engineer-bot')).subarray(0, 4096)],
  ['WebP with a wrong RIFF size', async () => { const bytes = Buffer.from(await shippedAvatar('engineer-bot')); bytes.writeUInt32LE(bytes.length, 4); return bytes; }],
])('refuses a %s avatar: only WebP ships', async (_label, make) => {
  const bytes = await make();
  const dir = await fixture();
  const base = path.join(dir, 'engineer-bot', version);
  await fs.unlink(path.join(base, 'assets/avatar.webp'));
  await fs.writeFile(path.join(base, 'assets/avatar.webp'), bytes);
  const file = path.join(base, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.integrity.files['assets/avatar.webp'] = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(file, JSON.stringify(manifest));
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('ships a WebP avatar that every consumer on the way accepts: bounded size, still image, no colour-space tricks, SDR bytes kept as they are', async () => {
  for (const id of BOT_PACKAGE_IDS) {
    const bytes = await shippedAvatar(id);
    expect(bytes.length, id).toBeLessThan(20_000);
    expect(bytes.toString('latin1', 12, 16), id).toBe('VP8 '); // one lossy image chunk, so no ICC, EXIF, XMP or animation
    const meta = await sharp(bytes).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height, pages: meta.pages ?? 1, icc: meta.icc === undefined, exif: meta.exif === undefined }, id)
      .toEqual({ format: 'webp', width: 256, height: 256, pages: 1, icc: true, exif: true });
    // The same bytes pass the avatar allow-list and the HDR→SDR step leaves SDR WebP untouched, so the stored blob is the shipped file.
    expect(sniffImageMime(bytes), id).toBe('image/webp');
    const sdr = await toSdrAvatarImage({ buffer: bytes, mimeType: 'image/webp' });
    expect(sdr.buffer.equals(bytes), id).toBe(true);
    expect((await readNativeBotPackage(root, id)).snapshot.avatarImageBase64, id).toBe(bytes.toString('base64'));
  }
});
const SHIPPED_ONLY = (id: string) => ['manifest.json', 'assets/avatar.webp', 'knowledge/method.md', `skills/${id}-ops/SKILL.md`, `skills/${id}-ops/templates/delivery.md`,
  `skills/${id}-evidence/SKILL.md`, `skills/${id}-evidence/templates/input.json`, `skills/${id}-evidence/templates/contract.md`, `skills/${id}-getting-started/SKILL.md`];
it('ships only what the client reads: the manifest, the avatar, the knowledge body and the Skill files, with a compact manifest', async () => {
  const walk = async (dir: string, prefix = ''): Promise<string[]> => (await Promise.all((await fs.readdir(dir)).map(async name => {
    const full = path.join(dir, name);
    return (await fs.stat(full)).isDirectory() ? walk(full, `${prefix}${name}/`) : [`${prefix}${name}`];
  }))).flat();
  for (const id of BOT_PACKAGE_IDS) {
    const files = (await walk(path.join(root, id, version))).sort();
    const script = files.filter(name => name.startsWith(`skills/${id}-evidence/scripts/`));
    expect(script, id).toHaveLength(1);
    expect(files, id).toEqual([...SHIPPED_ONLY(id), ...script].sort());
    for (const audit of ['PACKAGE.md', 'profile/adaptation.json', 'profile/asset-binding.json', 'profile/authorship.json', 'profile/behavior-evaluation.json',
      'profile/identity.md', 'profile/source-evidence.json', 'routines/selection.json']) expect(files, `${id}: ${audit}`).not.toContain(audit);
    const raw = await fs.readFile(path.join(root, id, version, 'manifest.json'), 'utf8');
    expect(raw, id).toBe(JSON.stringify(JSON.parse(raw))); // no indentation or other whitespace
    const manifest = JSON.parse(raw);
    expect(Object.keys(manifest.integrity.files).sort(), id).toEqual(files.filter(name => name !== 'manifest.json'));
    expect(manifest.routines.every((routine: Record<string, unknown>) => !('sourcePaths' in routine)), id).toBe(true);
    // The Chinese personality text is read from the manifest, never from a file next to it.
    expect(typeof manifest.profile.identitySource).toBe('string');
  }
});

const SCRIPT: Record<string, RegExp> = { en: /^[^\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+$/, ja: /[\u3040-\u30ff\u3400-\u9fff]/, ko: /[\uac00-\ud7af]/, 'zh-TW': /[\u3400-\u9fff]/ };
it('carries authored copy in en, ja, ko and zh-TW for every package, mirroring the Chinese copy', async () => {
  for (const id of BOT_PACKAGE_IDS) {
    const { entry } = await readNativeBotPackage(root, id);
    expect(Object.keys(entry.locales).sort(), id).toEqual(['en', 'ja', 'ko', 'zh-TW']);
    for (const [locale, copy] of Object.entries(entry.locales)) {
      const label = `${id} ${locale}`;
      expect(copy.skills, label).toHaveLength(entry.skills.length);
      expect(copy.tools.map(tool => tool.id), label).toEqual(entry.tools.map(tool => tool.id));
      expect(copy.remembers, label).toHaveLength(entry.remembers.length);
      expect(copy.routines.map(routine => routine.cron), label).toEqual(entry.routines.map(routine => routine.cron));
      expect(copy.capabilities.map(capability => capability.icon), label).toEqual(entry.capabilities.map(capability => capability.icon));
      expect(Object.keys(copy.itemNames).sort(), label).toEqual(Object.keys(entry.itemNames).sort());
      const texts = [copy.name, copy.description, copy.welcome, ...copy.capabilities.map(capability => capability.label),
        ...copy.skills.flatMap(skill => [skill.name, skill.description]), ...copy.knowledge.flatMap(doc => [doc.title, doc.summary]),
        ...copy.remembers, ...copy.tools.map(tool => tool.purpose), ...copy.routines.flatMap(routine => [routine.name, routine.summary]), ...Object.values(copy.itemNames)];
      for (const text of texts) expect(text, `${label}: ${text}`).toMatch(SCRIPT[locale]!);
      // Traditional Chinese never carries Simplified-only forms or kana/Hangul; no language carries maintainer wording.
      for (const text of texts) expect(text, `${label}: ${text}`).not.toMatch(/配方|本包|UTC|脚本|腳本|\.py\b|\bscripts?\b|\brecipes?\b/i);
      if (locale === 'zh-TW') for (const text of texts) expect(text, `${label}: ${text}`).not.toMatch(/[们这为开关与对会时书产价优体兴写决别务动区华单发变号员图场处备实导层师带帮并应总战择报据显权气汇济满灯热爱状独现环离稳竞笔点标样构条档检设确码积种称简类级纪约组经结给绝统继续维绿网罗职联脑艺观览规视计订认让训议记许论访评识证词诉译试话该询语误说请读课调谈谢谱贝负财责败货质购费资赛赶车转轮软轻载较输边达迁过运还进远连迟选递逻钱铁银错键长门闭问间阅队际随隐难页项顺须预领题颜风飞馆驱验鱼鸟齐齿]|[\u3040-\u30ff\uac00-\ud7af]/);
    }
  }
});
it.each([
  ['a language the host does not know', (m: Manifest) => { m.presentation.i18n.fr = m.presentation.i18n.en!; }],
  ['a Skill ref that differs from detailZh', (m: Manifest) => { m.presentation.i18n.ja!.detail.skills[0]!.ref = 'engineer-bot-evidence'; }],
  ['an English title over the scaled limit', (m: Manifest) => { m.presentation.i18n.en!.detail.skills[0]!.title = 'T'.repeat(37); }],
  ['a Japanese title over the scaled limit', (m: Manifest) => { m.presentation.i18n.ja!.detail.skills[0]!.title = '字'.repeat(19); }],
  ['a different number of starter options', (m: Manifest) => { m.presentation.i18n.ko!.starterOptions.pop(); }],
  ['an unknown extra routine field', (m: Manifest) => { m.presentation.i18n.en!.detail.routines[0]!.extra = 1; }],
  ['a remembers list of another length', (m: Manifest) => { m.presentation.i18n.en!.detail.memory.remembers.pop(); }],
  ['an unknown extra field', (m: Manifest) => { (m.presentation.i18n.en as unknown as Record<string, unknown>).extra = 1; }],
])('rejects localized copy with %s', async (_label, change) => {
  const dir = await edit('engineer-bot', change);
  await expect(readNativeBotPackage(dir, 'engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
});
it('shapes the import snapshot for the invite language and leaves it alone without one', async () => {
  const base = await readNativeBotPackage(root, 'engineer-bot');
  const authored = (JSON.parse(await fs.readFile(path.join(root, 'engineer-bot', version, 'manifest.json'), 'utf8')) as Manifest).presentation.i18n;
  const routineTitle = (locale: string) => (authored[locale]!.detail.routines[0] as unknown as { title: string }).title;
  const ja = await readNativeBotPackage(root, 'engineer-bot');
  applyNativeLocale(ja, 'ja');
  expect(ja.snapshot.source.name).toBe(authored.ja!.displayName);
  expect(ja.snapshot.nativePackage!.description).toBe(authored.ja!.valueDescription);
  expect(ja.snapshot.nativePackage!.opening).toMatchObject({ welcome: authored.ja!.welcome, capabilities: authored.ja!.capabilities,
    onboardingSkill: 'engineer-bot-getting-started', starterOptions: authored.ja!.starterOptions });
  const routine = ja.snapshot.items.find(item => item.automation)!;
  expect(routine.view.name).toBe(routineTitle('ja'));
  expect(routine.automation!.input!.name).toBe(routineTitle('ja'));
  expect(ja.snapshot.items.find(item => item.view.id === 'package-identity')!.view.name).toBe(authored.ja!.displayName);
  // Package identity and the routine fingerprints (receipt identity) do not depend on the language.
  expect(ja.identity).toEqual(base.identity);
  expect(routine.automation!.fingerprint).toBe(base.snapshot.items.find(item => item.automation)!.automation!.fingerprint);
  expect(routine.automation!.original).toEqual(base.snapshot.items.find(item => item.automation)!.automation!.original);
  for (const language of [undefined, '', 'zh-CN']) {
    const untouched = await readNativeBotPackage(root, 'engineer-bot');
    applyNativeLocale(untouched, language);
    expect(untouched.snapshot, String(language)).toEqual(base.snapshot);
  }
  const unknown = await readNativeBotPackage(root, 'engineer-bot');
  applyNativeLocale(unknown, 'fr');
  expect(unknown.snapshot.source.name).toBe(authored.en!.displayName);
  const traditional = await readNativeBotPackage(root, 'engineer-bot');
  applyNativeLocale(traditional, 'zh-Hant-TW');
  expect(traditional.snapshot.source.name).toBe(authored['zh-TW']!.displayName);
});
