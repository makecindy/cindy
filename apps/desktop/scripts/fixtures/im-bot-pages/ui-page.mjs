import assert from 'node:assert/strict';

const MEI = { id: 'bot-mei', name: '小美', status: 'active', avatar: '', avatarColor: '', enabled: true, skills: [], capabilities: {}, createdAt: 0, sessions: [], description: '' };
const DASH = { ...MEI, id: 'bot-dash', name: 'Dash' };

export default {
  name: 'im-bot-pages',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 900 },
  real: 'ImBotSection list and app pages, personal bot pages (Telegram, WeChat), ImReplyTargetField, ImDefaultSettingsSection, Telegram persona page, settings rows, translations and themes',
  notCovered: 'Project permission confirmation dialog, Official Cindy bots (local mode here; covered in the real Desktop), main-process routing of the reply target, live transports',
  stubs: {
    // Local mode: no official group, so the official hook view is not needed here.
    'src/renderer/contexts/AuthContext': { partial: `export const useAuth = () => ({ mode: 'local', dataOwnerId: 'fixture-account', user: null });` },
    // Teammate roster comes from the main-process profile store; the page only reads it.
    'src/renderer/features/bots/botStore': { partial: `export const useBotProfiles = () => ${JSON.stringify([MEI, DASH])};` },
    'src/renderer/components/settings/TelegramRemoteDevices': 'export const TelegramRemoteDevices = () => null;',
    'src/renderer/components/settings/ImPluginEntrances': `export const useImEntrancePlugins = () => []; export const ImPluginEntrancesCard = () => null; export const isImEntrancePlugin = () => false;`,
  },
  cases: {
    default: { about: 'List: connected apps first with who replies, the rest under 还可以连接', data: { telegramCompanion: 'bot-mei' } },
    'telegram-cindy': { about: 'Telegram page, Cindy replies: model and more rows shown', data: { telegramCompanion: null, open: 'telegram' } },
    'telegram-companion': { about: 'Telegram page handed to a teammate: Cindy-only rows fold away', data: { telegramCompanion: 'bot-mei', open: 'telegram' } },
    'telegram-project': { about: 'Telegram page with a project: only the project picker, no model row (models live in 项目与模型)', data: { telegramCompanion: null, telegramProject: '/Users/me/Projects/demo-shop', open: 'telegram' } },
    'telegram-chats-collapsed': { about: 'Group chats card on the Telegram page, collapsed: counts and avatars', data: { telegramCompanion: null, open: 'telegram', deeper: 'chats', collapsed: true } },
    'telegram-chats': { about: 'Group chats card expanded: one row per group with its status on the right; a paused group is marked', data: { telegramCompanion: null, open: 'telegram', deeper: 'chats' }, viewport: { width: 800, height: 1100 } },
    'telegram-chats-narrow': { about: 'Group chats card at 320px with a group opened', data: { telegramCompanion: null, open: 'telegram', deeper: 'chats', expand: '周末徒步群' }, viewport: { width: 320, height: 1500 } },
    'telegram-chats-open': { about: 'A paused group opened: project, model and permission side by side, then Members can ask too with Resume', data: { telegramCompanion: null, open: 'telegram', deeper: 'chats', expand: '周末徒步群' }, viewport: { width: 800, height: 1300 } },
    'telegram-persona': { about: 'One level deeper: name and personality page', data: { telegramCompanion: null, open: 'telegram', deeper: 'persona' } },
    'wechat-cindy': { about: 'WeChat page, connected', data: { telegramCompanion: null, open: 'wechat' } },
    'telegram-narrow': { about: 'Telegram page at 320px', data: { telegramCompanion: null, open: 'telegram' }, viewport: { width: 320, height: 900 } },
  },
  async ready(page) {
    await page.locator('[data-im-bot-app]').first().waitFor();
  },
  async check(page, ui) {
    if (!ui.data.open) {
      assert.ok(await page.getByText(await ui.t('settings.imBot.list.connected'), { exact: true }).isVisible());
      return;
    }
    await page.locator(`[data-im-bot-app="${ui.data.open}"]`).click();
    await page.getByRole('button', { name: await ui.t('settings.imBot.nav.back') }).first().waitFor();
    if (ui.data.deeper === 'chats') {
      const card = page.locator('[data-im-chat-card="telegram"]');
      // 收起时: 群数与单独设置数写在标题旁。
      await card.getByText(await ui.t('settings.imBot.chats.groupCount', { count: 3 }), { exact: false }).waitFor();
      if (ui.data.collapsed) return;
      await card.getByRole('button', { name: await ui.t('settings.imBot.chats.expand') }).click();
      await page.getByText('产品讨论组').waitFor();
      assert.ok(await page.getByText(await ui.t('settings.imBot.chats.members.pausedChip')).isVisible());
      if (ui.data.expand) {
        await page.getByRole('button', { name: await ui.t('settings.imBot.chats.expandAria', { name: ui.data.expand }) }).click();
        await page.getByRole('button', { name: await ui.t('settings.imBot.chats.members.resume') }).waitFor();
        await page.getByRole('checkbox').waitFor();
      }
      return;
    }
    if (ui.data.deeper === 'persona') {
      await page.getByRole('button', { name: await ui.t('settings.imBot.rows.persona') }).click();
      await page.getByRole('heading', { name: await ui.t('settings.imBot.rows.persona') }).waitFor();
      return;
    }
    if (ui.data.open === 'telegram') {
      const model = page.getByRole('button', { name: new RegExp('^' + await ui.t('settings.imBot.rows.model')) });
      const project = page.getByRole('combobox', { name: await ui.t('settings.imBot.rows.project') });
      if (ui.data.telegramCompanion) assert.equal(await project.count(), 0);
      else await project.waitFor();
      // 选了项目: 模型与权限只在「项目与模型」里改, 子页不再有「模型」行。
      if (ui.data.telegramCompanion || ui.data.telegramProject) assert.equal(await model.count(), 0);
      else await model.first().waitFor();
      if (ui.data.telegramProject) {
        await page.getByText(await ui.t('settings.imBot.rows.projectHint'), { exact: true }).waitFor();
      }
    }
  },
};
