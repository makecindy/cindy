import type { TFunction } from 'i18next';

/**
 * IM 渠道(消息平台)的显示名:聊天里的来源卡片头、Hook 来源标签与侧栏的消息平台组共用。
 * 未知渠道原样显示。
 */
export function imLabel(im: string, t: TFunction): string {
  switch (im) {
    case 'slack':
      return t('settings.tina.prefs.providerSlack');
    case 'telegram':
      return t('settings.tina.prefs.providerTelegram');
    case 'x':
      return t('settings.tina.prefs.providerX');
    case 'feishu':
      return t('settings.feishuBot.services.feishu');
    case 'lark':
      return t('settings.feishuBot.services.lark');
    case 'imessage':
      return t('bots.channels.platform.imessage');
    case 'discord':
      return t('settings.about.social.discordLabel');
    case 'wechat':
      return t('login.social.wechat');
    case 'wecom':
      return t('settings.wecomBot.serviceName');
    case 'dingtalk':
      return t('settings.dingtalkBot.serviceName');
    default:
      return im;
  }
}
