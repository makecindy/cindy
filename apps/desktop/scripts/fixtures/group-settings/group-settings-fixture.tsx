/** Isolated test adapter: a shared group's settings drawer, seen as its owner, an admin or a member. */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ctx, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupSettingsDrawer } from '../../../src/renderer/features/bots/BotGroupSettingsDrawer';
import { BOT_GROUP_SETTINGS_PARAM } from '../../../src/renderer/features/bots/botGroupPresentation';
import { refreshBotGroups } from '../../../src/renderer/features/bots/botGroupStore';

interface Data {
  role: 'owner' | 'admin' | 'member';
  /** You created the group and nobody else joined yet. */
  alone?: boolean;
  archived?: boolean;
  dissolved?: boolean;
  /** No 群介绍 yet. */
  noAbout?: boolean;
  /** Teammates of yours that are not in the group yet, offered by 邀请伙伴. */
  spare?: number;
}

const data = ctx.data as unknown as Data;
const groupId = 'group-settings-fixture';
const T0 = new Date(2026, 9, 28, 14, 30).getTime();
const person = (actorId: string, name: string, role: 'owner' | 'admin' | 'member', isSelf = false) => ({
  actorId, botId: actorId, actorKind: 'human', name, displayName: name, role, isSelf, isOwned: isSelf,
  avatar: '', avatarColor: 'gray', status: 'active', groupAvatar: null, avatarUrl: null,
});
const teammate = (actorId: string, name: string, owned: boolean, extra: Record<string, unknown> = {}) => ({
  actorId, botId: actorId, actorKind: 'bot', name, role: 'member', isOwned: owned, ownerName: owned ? 'Nana' : 'Alex',
  avatar: owned ? 'cindy://avatar/preset/cindy' : '🦉', avatarColor: 'gray', status: 'active', guestAccess: 'chat', ...extra,
});
const me = person('me', 'Nana', data.role, true);
const members = data.alone ? [me] : [
  me,
  person('alex', 'Alex', data.role === 'owner' ? 'admin' : 'owner'),
  person('mia', 'Mia', data.role === 'admin' ? 'member' : 'admin'),
  person('lin', 'Lin', 'member'),
  teammate('aster', 'Aster', true, { guestAccess: 'tools' }),
  teammate('pico', 'Pico', true, { status: 'paused' }),
  teammate('nova', 'Nova', false),
];
const group = {
  id: groupId, name: 'Cindy 发布小组', serverBacked: true, revision: 3, selfActorId: 'me',
  topic: data.noAbout ? '' : '周四发版前收口 Android 更新卡与伙伴群聊',
  description: data.noAbout ? '' : '这里讨论每周发版：确认要合并的 PR、跑完回归、整理更新说明。\n\n需要谁处理就直接 @ 他；不确定的事情先发在群里，别私下拍板。\n发版当天由负责人统一确认，其他人只补充事实。\n周五回顾这一周的问题。',
  replyMode: 'mentioned', speakingMode: 'auto', singleSpeaker: false, members,
  organizerBotId: data.alone ? null : 'aster', projectDir: data.role === 'member' ? null : '/Users/nana/Projects/cindy', autoContinue: false,
  supportsDissolve: true, supportsGroupLeave: true, supportsListRemoval: true, supportsMemberAvatar: true,
  canInvite: data.role !== 'member', archived: !!data.archived, dissolvedAt: data.dissolved ? '2026-10-29T08:00:00Z' : null,
  lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, plans: [], messages: [],
  hasMoreBefore: false, round: { status: 'idle', speakers: [], canContinue: false }, createdAt: T0, updatedAt: T0,
};
const spare = Array.from({ length: data.spare ?? 2 }, (_, index) => ({ actorId: `spare-${index}`, botId: `spare-${index}`, name: `伙伴 ${index + 1}` }));

void mountPage({
  route: `/bots/groups/${groupId}`,
  host: {
    maker: {
      listBotGroups: async () => ({ ok: true, groups: [group] }),
      getBotGroup: async () => ({ ok: true, group }),
      onBotGroupChanged: subscription('botGroupChanged'),
      updateBotGroup: forbid('maker.updateBotGroup'),
      chatServer: {
        ownedBots: async () => ({ ok: true, bots: [{ actorId: 'aster', botId: 'aster', name: 'Aster' }, { actorId: 'pico', botId: 'pico', name: 'Pico' }, ...spare] }),
        manage: forbid('maker.chatServer.manage'),
        createInvite: forbid('maker.chatServer.createInvite'),
      },
    },
    dialog: { showOpenDirectory: forbid('dialog.showOpenDirectory') },
    profileGetState: forbid('profileGetState'),
    profileUpdate: forbid('profileUpdate'),
  },
  render: () => <OpenSettings />,
});

/** The drawer is route-owned: open it the way the header button does. */
function OpenSettings() {
  const [, setSearchParams] = useSearchParams();
  // The drawer reads the shared group list, which the sidebar normally loads. Open it once:
  // setSearchParams changes with every page the drawer opens.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    refreshBotGroups();
    setSearchParams({ [BOT_GROUP_SETTINGS_PARAM]: '1' }, { replace: true });
  }, [setSearchParams]);
  return <BotGroupSettingsDrawer />;
}
