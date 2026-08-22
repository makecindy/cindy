import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import * as tar from 'tar';

import { redactSensitive } from '../learn-host/redaction.js';
import { getDbClient } from './client/current.js';
import {
  botAutomationLinks,
  botChannels,
  botLifecycleEvents,
  botProfiles,
  botProfileVersions,
  schedules,
} from './schema.js';
import {
  inspectBotBundleArchive,
  safelyExtractBotBundle,
} from './botPortabilityArchive.js';
import {
  CINDY_BOT_BUNDLE_FORMAT,
  CINDY_BOT_BUNDLE_VERSION,
  type BotBundleImportResult,
  type CindyBotBundleManifest,
  type PortableBotAutomationDefinition,
  type PortableBotChannelKind,
  isCindyBotBundleManifest,
} from '../../shared/botPortability.js';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_TEXT_BYTES = 2 * 1024 * 1024;
const EXCLUSIONS = [
  'credentials',
  'channel-bindings',
  'sessions',
  'history',
  'memory',
  'worktrees',
  'local-paths',
  'runtime-state',
] as const;

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function portableCapabilities(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'model',
    'harness',
    'skillMode',
    'skills',
    'toolsetMode',
    'toolsets',
    'mcpMode',
    'mcpServers',
    'memory',
    'automation',
    'permissions',
  ] as const;
  return Object.fromEntries(keys.filter((key) => key in raw).map((key) => [key, raw[key]]));
}

function safeBundleName(name: string): string {
  const base = name
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || 'cindy-bot';
}

function redactText(value: string): { text: string; hits: number } {
  const result = redactSensitive(value);
  return { text: result.text, hits: result.hitCount };
}

function redactJsonObject(value: Record<string, unknown>): {
  value: Record<string, unknown>;
  hits: number;
} {
  const redacted = redactText(JSON.stringify(value));
  try {
    const parsed = JSON.parse(redacted.text) as unknown;
    return {
      value: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
      hits: redacted.hits,
    };
  } catch {
    return { value: {}, hits: redacted.hits };
  }
}

export async function exportBotBehaviorBundle(botId: string, outputPath: string): Promise<{
  filePath: string;
  redactionCount: number;
  warnings: string[];
}> {
  const db = getDbClient().drizzle;
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile) throw new Error('Bot 不存在');
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, botId),
        eq(botProfileVersions.version, profile.currentVersion),
      ),
    )
    .limit(1);
  if (!version) throw new Error('Bot 当前 Profile 版本不存在');
  const [channelRows, linkRows] = await Promise.all([
    db.select().from(botChannels).where(eq(botChannels.botId, botId)),
    db.select().from(botAutomationLinks).where(eq(botAutomationLinks.botId, botId)),
  ]);
  const scheduleRows = linkRows.some((link) => link.scheduleId)
    ? await db
        .select()
        .from(schedules)
        .where(
          inArray(
            schedules.id,
            linkRows.flatMap((link) => (link.scheduleId ? [link.scheduleId] : [])),
          ),
        )
    : [];
  const scheduleById = new Map(scheduleRows.map((schedule) => [schedule.id, schedule]));
  const rawCapabilities = parseObject(version.capabilitiesJson);
  const userContext = typeof rawCapabilities.userContextSource === 'string'
    ? rawCapabilities.userContextSource
    : '';
  const soul = redactText(version.identitySource);
  const user = redactText(userContext);
  const profileName = redactText(profile.displayName);
  const profileDescription = redactText(profile.description);
  const capabilities = redactJsonObject(portableCapabilities(rawCapabilities));
  let redactionCount =
    soul.hits + user.hits + profileName.hits + profileDescription.hits + capabilities.hits;
  const automations: PortableBotAutomationDefinition[] = [];
  for (const link of linkRows) {
    if (!link.scheduleId) continue;
    const schedule = scheduleById.get(link.scheduleId);
    if (!schedule) continue;
    const name = redactText(schedule.name);
    const prompt = redactText(schedule.prompt);
    const script = schedule.scriptConfig ? redactText(schedule.scriptConfig) : null;
    redactionCount += name.hits + prompt.hits + (script?.hits ?? 0);
    const executionPolicy = redactJsonObject(parseObject(link.executionPolicyJson));
    redactionCount += executionPolicy.hits;
    automations.push({
      name: name.text,
      prompt: prompt.text,
      executionMode: schedule.executionMode,
      ...(script?.text ? { scriptConfig: script.text } : {}),
      cronExpr: schedule.cronExpr,
      timezone: schedule.timezone,
      recurring: schedule.recurring,
      manual: schedule.manual,
      ...(schedule.intervalMs != null ? { intervalMs: schedule.intervalMs } : {}),
      agentKind: schedule.agentKind,
      ...(schedule.model ? { model: schedule.model } : {}),
      ...(schedule.providerId ? { providerId: schedule.providerId } : {}),
      ...(schedule.effort ? { effort: schedule.effort } : {}),
      fastMode: schedule.fastMode,
      persistentSession: schedule.persistentSession,
      silentWhenIdle: schedule.silentWhenIdle,
      notifyDesktop: schedule.notifyDesktop,
      notifyFeishu: false,
      notifyWecomGroup: false,
      executionPolicy: executionPolicy.value,
      enabled: false,
    });
  }
  const manifest: CindyBotBundleManifest = {
    format: CINDY_BOT_BUNDLE_FORMAT,
    version: CINDY_BOT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    bot: {
      name: profileName.text,
      description: profileDescription.text,
      avatar: profile.avatar,
      avatarColor: profile.avatarColor,
    },
    profile: {
      soul: 'SOUL.md',
      user: 'USER.md',
      capabilities: capabilities.value,
    },
    channels: [...new Set(channelRows.map((channel) => channel.kind))].map((kind) => ({
      kind,
      enabled: kind === 'local',
    })),
    automations,
    exclusions: EXCLUSIONS,
  };

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-export-'));
  const rootName = safeBundleName(profile.displayName);
  const rootDir = path.join(stagingDir, rootName);
  try {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.writeFile(path.join(rootDir, 'SOUL.md'), soul.text, { mode: 0o600 }),
      fs.writeFile(path.join(rootDir, 'USER.md'), user.text, { mode: 0o600 }),
      fs.writeFile(path.join(rootDir, 'bot.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      }),
    ]);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await tar.c({ gzip: true, cwd: stagingDir, file: outputPath, portable: true }, [rootName]);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
  return {
    filePath: outputPath,
    redactionCount,
    warnings: redactionCount > 0 ? ['导出内容已自动移除可能的凭证、身份信息或本机路径'] : [],
  };
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Bot 配置包包含非法文件');
  if (stat.size > maxBytes) throw new Error('Bot 配置包文件超过大小上限');
  return fs.readFile(filePath, 'utf8');
}

export async function importBotBehaviorBundle(archivePath: string): Promise<BotBundleImportResult> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-import-'));
  try {
    // Copy once into private staging so a caller cannot replace the archive
    // between the validation pass and extraction (TOCTOU).
    const stagedArchive = path.join(stagingDir, 'input.cindybot');
    await fs.copyFile(archivePath, stagedArchive);
    await fs.chmod(stagedArchive, 0o600);
    const inspection = await inspectBotBundleArchive(stagedArchive);
    const expectedFiles = new Set([
      `${inspection.root}/bot.json`,
      `${inspection.root}/SOUL.md`,
      `${inspection.root}/USER.md`,
    ]);
    for (const entry of inspection.entries) {
      const normalized = entry.path.replaceAll('\\', '/').replace(/\/$/, '');
      if (entry.type === 'File' && !expectedFiles.has(normalized)) {
        throw new Error(`Bot 配置包包含未声明文件: ${normalized}`);
      }
    }
    const extractedDir = path.join(stagingDir, 'extracted');
    const rootDir = await safelyExtractBotBundle(stagedArchive, extractedDir);
    const manifestText = await readBoundedText(path.join(rootDir, 'bot.json'), MAX_MANIFEST_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      throw new Error('Bot 配置包 manifest 不是有效 JSON');
    }
    if (!isCindyBotBundleManifest(parsed)) throw new Error('Bot 配置包格式或版本不受支持');
    const manifest = parsed;
    const soul = await readBoundedText(path.join(rootDir, manifest.profile.soul), MAX_PROFILE_TEXT_BYTES);
    const user = await readBoundedText(path.join(rootDir, manifest.profile.user), MAX_PROFILE_TEXT_BYTES);
    const now = Date.now();
    const botId = `bot_${randomUUID()}`;
    const channelKinds = [...new Set<PortableBotChannelKind>([
      'local',
      ...manifest.channels.map((channel) => channel.kind),
    ])];
    await getDbClient().tx('bots.importBehaviorBundle', {
      bot: {
        id: botId,
        displayName: manifest.bot.name.trim(),
        description: manifest.bot.description,
        avatar: manifest.bot.avatar || '🤖',
        avatarColor: manifest.bot.avatarColor || 'violet',
        identitySource: soul,
        capabilitiesJson: JSON.stringify({
          ...portableCapabilities(manifest.profile.capabilities),
          userContextSource: user,
          // A shared bundle is never authority to grant unattended execution.
          // The user must explicitly re-enable Automation and trusted mode on
          // this device after reviewing installed Skills/MCP/Toolsets.
          permissions: 'ask',
          automation: false,
        }),
      },
      channels: channelKinds.map((kind) => ({
        id: `${botId}:${kind}:${randomUUID()}`,
        kind,
        enabled: kind === 'local',
      })),
      automations: manifest.automations.map((automation) => ({
          scheduleId: `schedule_${randomUUID()}`,
          linkId: `bot_automation_${randomUUID()}`,
          name: automation.name,
          prompt: automation.prompt,
          executionMode: automation.executionMode,
          scriptConfig: automation.scriptConfig ?? null,
          cronExpr: automation.cronExpr,
          timezone: automation.timezone,
          recurring: automation.recurring,
          manual: automation.manual,
          intervalMs: automation.intervalMs ?? null,
          agentKind: automation.agentKind,
          model: automation.model ?? null,
          providerId: automation.providerId ?? null,
          effort: automation.effort ?? null,
          fastMode: automation.fastMode,
          persistentSession: automation.persistentSession,
          silentWhenIdle: automation.silentWhenIdle,
          notifyDesktop: automation.notifyDesktop,
          executionPolicyJson: JSON.stringify(automation.executionPolicy ?? {}),
      })),
      now,
      eventId: `${botId}:imported:${now}`,
    });
    return {
      canceled: false,
      botId,
      botName: manifest.bot.name,
      disabledChannels: channelKinds.filter((kind) => kind !== 'local'),
      pausedAutomations: manifest.automations.length,
      warnings: [
        'IM 账号与凭证未导入，外部 Channel 需要重新绑定',
        'Automation 已导入为暂停状态，需要检查项目与权限后手动启用',
      ],
    };
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}
