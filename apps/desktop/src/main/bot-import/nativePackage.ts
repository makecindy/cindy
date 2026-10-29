import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseRoutineInput } from '@cindy/maker-scheduler';
import { BOT_CAPABILITY_ICONS, botMarketLocale, type BotCapabilityIcon, type BotMarketCopy, type BotMarketEntry, type BotMarketLocale, type BotPackageIdentity } from '../../shared/botMarket.js';
import { validateBotSkillFiles } from '../maker-ipc/botSkillStore.js';
import { CompanionImportError, type ImportItem, type ImportSnapshot } from './types.js';

// This is a bundled catalog, not an arbitrary archive/path/URL importer.
export const BOT_PACKAGE_IDS = ['engineer-bot', 'nightly-audit-engineer', 'startup-qa-bot',
  'seo-aeo-desk', 'cooper', 'video-editor', 'proto-bot',
  'ad-spend-watch', 'apple-search-ads-review', 'sable-game-art'] as const;
export const BOT_PACKAGE_VERSION = '0.5.1';
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const invalid = (): never => { throw new CompanionImportError('INVALID_PACKAGE'); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const text = (v: unknown, max = 12000): string => typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : invalid();
const array = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 100 ? v : invalid();
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Same sorted UTF-8 JSON algorithm as the offline package creator. */
export function canonicalPackageJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPackageJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPackageJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Avatars ship as a 256×256 WebP (RIFF container, its size field matching the file); anything else is refused. */
const isWebp = (bytes: Buffer): boolean => bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'
  && bytes.readUInt32LE(4) === bytes.length - 8;

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const result = record(value);
  if (Object.keys(result).length !== keys.length || keys.some(key => !(key in result))) invalid();
  return result;
};
const detailText = (value: unknown, max: number): string =>
  typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= max && !/\p{Cc}/u.test(value) ? value : invalid();
const bounded = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid();
const sameSet = (refs: string[], expected: string[]) => refs.length === expected.length && new Set(refs).size === refs.length && expected.every(ref => refs.includes(ref));

/** The package author's detail-page copy (`presentation.detailZh`); every ref must name a real entry of this package. */
function readDetail(value: unknown, known: { skills: string[]; knowledge: string[]; plugins: string[]; routines: string[] }, scale = 1) {
  const lim = (base: number) => Math.round(base * scale);
  const detail = exact(value, ['skills', 'memory', 'tools', 'routines']);
  const skills = bounded(detail.skills, 6).map(item => {
    const skill = exact(item, ['ref', 'title', 'summary']);
    return { ref: text(skill.ref, 64), title: detailText(skill.title, lim(12)), summary: detailText(skill.summary, lim(48)) };
  });
  if (!skills.length || !sameSet(skills.map(skill => skill.ref), known.skills)) invalid();
  const memory = exact(detail.memory, ['knowledge', 'remembers']);
  const knowledge = bounded(memory.knowledge, 3).map(item => {
    const doc = exact(item, ['ref', 'title', 'summary']);
    return { ref: text(doc.ref, 40), title: detailText(doc.title, lim(12)), summary: detailText(doc.summary, lim(60)) };
  });
  if (new Set(knowledge.map(doc => doc.ref)).size !== knowledge.length || knowledge.some(doc => !known.knowledge.includes(doc.ref))) invalid();
  const remembers = bounded(memory.remembers, 8).map(item => detailText(item, lim(10)));
  if (new Set(remembers).size !== remembers.length) invalid();
  const tools = bounded(detail.tools, 4).map(item => {
    const tool = exact(item, ['ref', 'purpose']);
    return { id: text(tool.ref, 100), purpose: detailText(tool.purpose, lim(24)) };
  });
  if (tools.length !== known.plugins.length || tools.some((tool, index) => tool.id !== known.plugins[index])) invalid();
  const routines = bounded(detail.routines, 8).map(item => {
    const routine = exact(item, ['ref', 'title', 'summary']);
    return { ref: text(routine.ref, 80), title: detailText(routine.title, lim(12)), summary: detailText(routine.summary, lim(40)) };
  });
  if (routines.length !== known.routines.length || routines.some((routine, index) => routine.ref !== known.routines[index])) invalid();
  return { skills, knowledge, remembers, tools, routines };
}

/** What the host needs of one language at invite time: profile name/description, opening text and routine names. */
export interface NativeLocalizedCopy { name: string; description: string; welcome: string; capabilityLabels: string[]; starterOptions: string[]; routineNames: Record<string, string> }
export interface NativeBotPackage { identity: BotPackageIdentity; entry: BotMarketEntry; snapshot: ImportSnapshot; localized: Record<BotMarketLocale, NativeLocalizedCopy> }

const LOCALES: readonly BotMarketLocale[] = ['en', 'ja', 'ko', 'zh-TW'];
const LOCALE_SCALE: Record<BotMarketLocale, number> = { en: 3, ja: 1.5, ko: 1.5, 'zh-TW': 1 };
const VALUE_MAX: Record<BotMarketLocale, number> = { en: 200, ja: 160, ko: 160, 'zh-TW': 120 };
const LABEL_MAX: Record<BotMarketLocale, number> = { en: 48, ja: 24, ko: 24, 'zh-TW': 16 };
/** The onboarding Skill is not part of the authored detail copy; its name only shows in a partial-save notice. */
const ONBOARDING_NAME: Record<BotMarketLocale, string> = { en: 'Getting started', ja: 'はじめの設定', ko: '시작 설정', 'zh-TW': '開場設定' };

type Detail = ReturnType<typeof readDetail>;
/** One language of `presentation.i18n`: same shape and limits family as the base copy, and it must mirror `detailZh`. */
function readLocale(locale: BotMarketLocale, value: unknown, known: Parameters<typeof readDetail>[1], zh: Detail, starterCount: number) {
  const block = exact(value, ['displayName', 'valueDescription', 'capabilities', 'welcome', 'starterOptions', 'detail', 'bubble']);
  const labels = bounded(block.capabilities, 3).map(label => detailText(label, LABEL_MAX[locale]));
  const starters = bounded(block.starterOptions, 4).map(option => detailText(option, 60));
  const detail = readDetail(block.detail, known, LOCALE_SCALE[locale]);
  if (labels.length !== 3 || starters.length !== starterCount || new Set(starters).size !== starters.length) invalid();
  if (detail.skills.some((skill, index) => skill.ref !== zh.skills[index]?.ref) || detail.knowledge.length !== zh.knowledge.length
    || detail.knowledge.some((doc, index) => doc.ref !== zh.knowledge[index]?.ref) || detail.remembers.length !== zh.remembers.length) invalid();
  const bubble = detailText(block.bubble, Math.round(20 * LOCALE_SCALE[locale]));
  return { name: detailText(block.displayName, 64), description: detailText(block.valueDescription, VALUE_MAX[locale]), welcome: detailText(block.welcome, 400), labels, starters, detail, bubble };
}

/** Shape the import snapshot for the language the invite was made in: profile name and description, the opening, routine names. */
export function applyNativeLocale(pkg: NativeBotPackage, language: string | undefined): void {
  if (!language) return; // no language given: the package's own Simplified Chinese copy
  const key = botMarketLocale(language);
  if (key === 'zh-CN') return;
  const copy = pkg.localized[key];
  const native = pkg.snapshot.nativePackage;
  if (!native?.opening) return;
  pkg.snapshot.source.name = copy.name;
  native.description = copy.description;
  native.opening = { ...native.opening, welcome: copy.welcome, capabilities: copy.capabilityLabels, starterOptions: copy.starterOptions };
  for (const item of pkg.snapshot.items) {
    if (item.view.id === 'package-identity') item.view = { ...item.view, name: copy.name };
    const routineName = item.automation ? copy.routineNames[item.automation.sourceId] : undefined;
    if (item.automation && routineName) {
      item.view = { ...item.view, name: routineName };
      if (item.automation.input) item.automation.input.name = routineName;
    }
  }
}

/** Validate every byte before constructing the existing private import input. */
export async function readNativeBotPackage(root: string, packageId: string): Promise<NativeBotPackage> {
  if (!(BOT_PACKAGE_IDS as readonly string[]).includes(packageId)) invalid();
  const directory = path.join(root, packageId, BOT_PACKAGE_VERSION);
  // Refuse links at every directory boundary, including the package root.
  for (const dir of [root, path.join(root, packageId), directory]) if (!(await fs.lstat(dir)).isDirectory() || (await fs.lstat(dir)).isSymbolicLink()) invalid();
  let total = 0;
  const files = new Map<string, Buffer>();
  async function walk(dir: string, prefix = ''): Promise<void> {
    for (const name of await fs.readdir(dir)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') invalid();
      const relative = prefix + name;
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) invalid();
      if (stat.isDirectory()) { if (relative.split('/').length > 8) invalid(); await walk(file, relative + '/'); }
      else {
        if (!stat.isFile() || stat.size > MAX_FILE || (total += stat.size) > MAX_TOTAL || files.size >= 200) invalid();
        const bytes = await fs.readFile(file);
        if (bytes.length !== stat.size) invalid();
        files.set(relative, bytes);
      }
    }
  }
  await walk(directory);
  const manifestBytes = files.get('manifest.json') ?? invalid();
  const manifest = record(JSON.parse(manifestBytes.toString('utf8')));
  if (manifest.schemaVersion !== 2 || manifest.packageId !== packageId || manifest.packageVersion !== BOT_PACKAGE_VERSION) invalid();
  const integrity = record(record(manifest.integrity).files);
  if (Object.keys(integrity).length !== files.size - 1) invalid();
  for (const [name, hash] of Object.entries(integrity)) {
    if (!files.has(name) || !/^[a-f0-9]{64}$/.test(String(hash)) || sha(files.get(name)!) !== hash || name === 'manifest.json') invalid();
  }
  const read = (ref: unknown) => {
    const name = text(ref, 240);
    if (!(name in integrity)) invalid();
    return files.get(name) ?? invalid();
  };
  const profile = record(manifest.profile), presentation = record(manifest.presentation);
  const dependencies = record(manifest.dependencies);
  if (record(dependencies.model).mode !== 'inherit') invalid();
  const identity = { packageId, packageVersion: BOT_PACKAGE_VERSION, packageHash: sha(canonicalPackageJson(manifest)) };
  const avatar = read(record(profile.avatar).path);
  if (!isWebp(avatar) || record(profile.avatar).kind !== 'asset') invalid();
  const name = text(profile.name, 200), description = text(profile.description);
  const identitySource = text(profile.identitySource);
  const items: ImportItem[] = [{ view: { id: 'package-identity', name, category: 'personality', selected: true }, text: identitySource, role: 'identity' }];
  const itemNames: Record<string, string> = { 'package-identity': name };
  // The onboarding Skill is the host's opening pipeline, already visible as the greeting; the page does not list it.
  const firstUse = record(manifest.firstUse);
  const onboardingSlug = firstUse.onboardingSkill;
  const skills = array(manifest.skills).map(value => {
    const skill = record(value), slug = text(skill.slug, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || skill.bodyPath !== `skills/${slug}/SKILL.md`) invalid();
    const prefix = `skills/${slug}/`;
    const references = [skill.bodyPath, ...array(skill.scripts), ...array(skill.resources)].map(ref => text(ref, 240));
    if (new Set(references).size !== references.length || references.some(ref => !ref.startsWith(prefix))) invalid();
    const subtree = [...files.keys()].filter(ref => ref.startsWith(prefix));
    if (subtree.length !== references.length || subtree.some(ref => !references.includes(ref))) invalid();
    const resources = references.map(ref => ({ name: ref.slice(prefix.length), bytes: read(ref), executable: false }));
    validateBotSkillFiles(slug, resources);
    items.push({ view: { id: `skill-${slug}`, name: slug, category: 'skills', selected: true, enabled: true }, files: resources, filesComplete: true });
    itemNames[`skill-${slug}`] = text(skill.name);
    return { slug, name: text(skill.name), description: text(skill.description) };
  }).filter(skill => skill.slug !== onboardingSlug);
  const knowledge = array(manifest.knowledge).map(value => {
    const doc = record(value), id = text(doc.id, 40);
    if (doc.type !== 'reference' || !/^[a-z0-9_-]+$/.test(id)) invalid();
    const title = text(doc.title);
    const itemId = `ref-${sha(packageId + ':' + id).slice(0, 32)}`;
    itemNames[itemId] = title;
    const body = read(doc.bodyPath).toString('utf8');
    items.push({ view: { id: itemId, name: title, category: 'memory', selected: true }, text: body });
    return { id, title };
  });
  const routines = array(manifest.routines).map(value => {
    const routine = record(value);
    if (routine.enabledByDefault !== false) invalid();
    const id = text(routine.id, 80);
    const input = parseRoutineInput({ name: text(routine.name), prompt: text(routine.prompt), triggers: routine.triggers, enabled: false });
    itemNames[`routine-${id}`] = input.name;
    items.push({ view: { id: `routine-${id}`, name: input.name, category: 'automations', selected: true, enabled: false },
      automation: { sourceId: id, input, original: routine, fingerprint: sha(canonicalPackageJson(routine)) } });
    const cron = input.triggers.find(trigger => trigger.kind === 'cron');
    return { id, name: input.name, ...(cron?.kind === 'cron' ? { cron: cron.expression } : {}) };
  });
  const plugins = array(dependencies.plugins).map(value => text(record(value).id, 100));
  const skillSlugs = items.flatMap(item => item.view.category === 'skills' ? [item.view.name] : []);
  const welcome = text(firstUse.welcome, 400);
  const onboardingSkill = firstUse.onboardingSkill === undefined ? undefined : text(firstUse.onboardingSkill, 64);
  if (onboardingSkill !== undefined && !skillSlugs.includes(onboardingSkill)) invalid();
  // The opening shows the package's own starter choices (`presentation.starterOptionsZh`), so the host never invents options.
  const starters = bounded(presentation.starterOptionsZh, 4).map(option => detailText(option, 60));
  if (starters.length < 3 || new Set(starters).size !== starters.length) invalid();
  const requiredInputs = array(record(firstUse.firstTask).requiredInputs).map(v => text(v));
  const capabilities = array(presentation.capabilitiesZh).map(value => {
    const capability = record(value), icon = text(capability.icon, 20) as BotCapabilityIcon;
    if (!BOT_CAPABILITY_ICONS.includes(icon) || Object.keys(capability).length !== 2) invalid();
    return { icon, label: text(capability.label, 16) };
  });
  if (capabilities.length !== 3) invalid();
  const known = { skills: skills.map(skill => skill.slug), knowledge: knowledge.map(doc => doc.id), plugins, routines: routines.map(routine => routine.id) };
  const detail = readDetail(presentation.detailZh, known);
  const bubble = detailText(presentation.bubbleZh, 20);
  // Every language must mirror the Chinese detail copy and starter options.
  const localesRaw = record(presentation.i18n);
  if (Object.keys(localesRaw).length !== LOCALES.length || LOCALES.some(locale => !(locale in localesRaw))) invalid();
  const localized = {} as Record<BotMarketLocale, NativeLocalizedCopy>;
  const locales = {} as Record<BotMarketLocale, BotMarketCopy>;
  for (const locale of LOCALES) {
    const l = readLocale(locale, localesRaw[locale], known, detail, starters.length);
    const knowledgeTitles = new Map(l.detail.knowledge.map(doc => [doc.ref, doc.title]));
    const names: Record<string, string> = { 'package-identity': l.name };
    for (const skill of skills) names[`skill-${skill.slug}`] = l.detail.skills.find(item => item.ref === skill.slug)?.title ?? skill.name;
    if (onboardingSkill) names[`skill-${onboardingSkill}`] = ONBOARDING_NAME[locale];
    for (const doc of knowledge) names[`ref-${sha(packageId + ':' + doc.id).slice(0, 32)}`] = knowledgeTitles.get(doc.id) ?? doc.title;
    routines.forEach((routine, index) => { names[`routine-${routine.id}`] = l.detail.routines[index]!.title; });
    locales[locale] = { name: l.name, description: l.description, welcome: l.welcome, bubble: l.bubble,
      capabilities: capabilities.map((capability, index) => ({ icon: capability.icon, label: l.labels[index]! })),
      skills: l.detail.skills.map(skill => ({ name: skill.title, description: skill.summary })),
      knowledge: l.detail.knowledge.map(doc => ({ title: doc.title, summary: doc.summary })),
      remembers: l.detail.remembers, tools: l.detail.tools,
      routines: routines.map((routine, index) => ({ name: l.detail.routines[index]!.title, summary: l.detail.routines[index]!.summary,
        ...(routine.cron ? { cron: routine.cron } : {}) })),
      itemNames: names };
    localized[locale] = { name: l.name, description: l.description, welcome: l.welcome, capabilityLabels: l.labels, starterOptions: l.starters,
      routineNames: Object.fromEntries(routines.map((routine, index) => [routine.id, l.detail.routines[index]!.title])) };
  }
  const avatarImageBase64 = avatar.toString('base64');
  const entry: BotMarketEntry = { ...identity, name: text(presentation.displayNameZh, 200),
    description: text(presentation.valueDescriptionZh), bubble, avatar: `data:image/webp;base64,${avatarImageBase64}`, welcome,
    capabilities, requiredInputs, itemNames, locales,
    skills: detail.skills.map(skill => ({ name: skill.title, description: skill.summary })),
    knowledge: detail.knowledge.map(doc => ({ title: doc.title, summary: doc.summary })),
    remembers: detail.remembers,
    tools: detail.tools,
    routines: routines.map((routine, index) => ({ name: detail.routines[index]!.title, summary: detail.routines[index]!.summary,
      ...(routine.cron ? { cron: routine.cron } : {}) })) };
  if (new Set(items.map(item => item.view.id)).size !== items.length) invalid();
  return { identity, entry, localized, snapshot: { source: { kind: 'cindy', agentId: packageId, name, root: '', workspace: '', configFile: '' },
    nativePackage: { ...identity, description, opening: { welcome, capabilities: capabilities.map(item => item.label),
      ...(onboardingSkill ? { onboardingSkill } : {}), starterOptions: starters } }, items, avatarImageBase64, fingerprint: identity.packageHash } };
}
