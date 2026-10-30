/** Owner-only sharing and identity selection. No credentials move and no extra transport is created. */
import type { FeishuIM, IMMessageEvent } from '@cindy/im';
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../../localDb/client/current';
import { botProfiles, botSessionLinks } from '../../localDb/schema';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState';
import { t } from '../../i18n';
import { bindingStore } from '../binding';
import { isInControl } from '../shared/controlState';
import type { BotImConnectionRecord } from '../../../shared/botImConnection';
import { DEFAULT_SCHEDULER_BOT_ID } from '../../../shared/botAutonomy';
import { listBotImConnections, readBotImConnection, updateBotImConnectionRecord } from '../shared/botImConnectionStore';

export function sharedFeishuBinding(record: BotImConnectionRecord, im: FeishuIM) {
  const shared = record.sharedFeishu;
  return shared && shared.appId === im.getBotAppId() && shared.ownerOpenId === im.getOwnerOpenId()
    ? shared : null;
}

export function createSharedFeishuControls(connectionId: string, im: FeishuIM) {
  return {
    readBinding: (appId: string, userId?: string): string | null => {
      const record = readBotImConnection(connectionId);
      if (!record) throw new Error('Feishu connection removed');
      // Groups and guest DMs retain the original dedicated companion and permissions.
      if (userId !== im.getOwnerOpenId() || !record.sharedFeishu) return record.botId;
      const shared = sharedFeishuBinding(record, im);
      if (!shared || appId !== shared.appId) throw new Error('Feishu shared owner changed');
      return shared.selectedBotId ?? DEFAULT_SCHEDULER_BOT_ID;
    },
    async handleControlMessage(event: IMMessageEvent): Promise<boolean> {
      if (event.attachments.length || event.unsupported.length || event.speaker || event.replyThread
        || event.senderId !== im.getOwnerOpenId()) return false;
      const match = /^\/(share|bot)(?:\s+(.*))?\s*$/i.exec(event.text.trim());
      if (!match) return false;
      const owner = activeOwnerScopeKey();
      const appId = im.getBotAppId();
      const ownerOpenId = im.getOwnerOpenId();
      const assertCurrent = () => {
        if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner
          || im.getStatus().kind !== 'connected' || im.getBotAppId() !== appId
          || im.getOwnerOpenId() !== ownerOpenId || event.contextId !== appId) throw new Error('Feishu account changed');
      };
      assertCurrent();
      const record = readBotImConnection(connectionId);
      if (!record || !appId || !ownerOpenId) throw new Error('Feishu connection unavailable');
      const reply = async (key: string, suffix = '') => {
        assertCurrent();
        await im.sendText(event.senderId, t(`settings.feishuBot.sharing.${key}`) + suffix);
      };
      const command = match[1].toLowerCase();
      const arg = match[2]?.trim() ?? '';
      if (isInControl(appId, event.senderId)) { await reply('controlBusy'); return true; }
      const detach = async () => {
        await bindingStore.detach({ channel: 'feishu', botContextId: appId, userId: event.senderId });
        assertCurrent();
      };
      if (command === 'share') {
        if (arg !== 'on' && arg !== 'off') { await reply('help'); return true; }
        if (arg === 'on' && listBotImConnections().some((r) => r.id !== connectionId && r.sharedFeishu)) {
          await reply('alreadyShared'); return true;
        }
        assertCurrent();
        await detach();
        const updated = await updateBotImConnectionRecord(connectionId, { sharedFeishu: arg === 'on'
          ? { appId, ownerOpenId, selectedBotId: null } : undefined }, assertCurrent);
        if (!updated) throw new Error('Feishu connection removed');
        await reply(arg === 'on' ? 'enabled' : 'disabled');
        return true;
      }
      const shared = sharedFeishuBinding(record, im);
      if (!shared) { await reply('help'); return true; }
      const snapshot = getCurrentDbClientSnapshot();
      if (!snapshot) throw new Error('DbClient not ready');
      const profiles = await snapshot.client.drizzle.select({ id: botProfiles.id, name: botProfiles.displayName, status: botProfiles.status })
        .from(botProfiles);
      assertCurrent();
      if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('Feishu account changed');
      if (!arg) {
        await reply('list', '\nCindy: /bot cindy\n' + profiles.filter((p) => p.status === 'active')
          .map((p) => `${p.name}: /bot ${p.id}`).join('\n'));
        return true;
      }
      const exactId = profiles.find((p) => p.id === arg);
      const fullNames = profiles.filter((p) => p.name === arg);
      // A short name is the complete identity before an explicit descriptor
      // separator, never an arbitrary substring or a first-match guess.
      const matches = exactId ? [exactId] : fullNames.length ? fullNames
        : profiles.filter((p) => p.name.split(/[@＠|｜]/, 1)[0].trim() === arg);
      const selected = arg.toLowerCase() === 'cindy' ? null : matches.length === 1 && matches[0].status === 'active' ? matches[0] : undefined;
      if (selected === undefined) {
        await reply('unknown', matches.length > 1
          ? '\n' + matches.map((p) => `${p.name.replace(/[\r\n]/g, ' ')}: /bot ${p.id}`).join('\n') : '');
        return true;
      }
      assertCurrent();
      await detach();
      const updated = await updateBotImConnectionRecord(connectionId, { sharedFeishu: { ...shared, selectedBotId: selected?.id ?? null } }, assertCurrent);
      if (!updated) throw new Error('Feishu connection removed');
      await reply('switched', selected?.name ?? 'Cindy');
      return true;
    },
    async outputPrefixForSession(sessionId: string): Promise<string> {
      if (!readBotImConnection(connectionId)?.sharedFeishu) return '';
      const snapshot = getCurrentDbClientSnapshot();
      if (!snapshot || isAppSessionBoundaryPending()) throw new Error('Feishu account unavailable');
      const row = await snapshot.client.drizzle.select({ name: botProfiles.displayName, id: botProfiles.id })
        .from(botSessionLinks).innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(eq(botSessionLinks.sessionId, sessionId)).limit(1).get();
      if (getCurrentDbClientSnapshot() !== snapshot || isAppSessionBoundaryPending()) throw new Error('Feishu account changed');
      const name = row ? `${row.name} · ${row.id}` : 'Cindy';
      return `【${name.replace(/[\r\n\[\]<>]/g, ' ')}】\n\n`;
    },
  };
}
