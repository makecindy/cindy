/**
 * botAiDisclosure — 伙伴首次启用时的一次性 AI 身份确认。
 *
 * 合规背景:拟人化互动服务要求在用户首次接触拟人化角色时,以显著方式
 * 告知「由 AI 驱动、非真人、不具备人类情感意识」,并让用户确认后再进入
 * 互动。参照监管解读「无需机械重复,但需持续保留稳定可见标识」,这里采用
 * 「首次弹窗确认 + 互动界面持续 Badge」的组合:
 * - 确认记录是**设备级**的 renderer 状态(localStorage),不进 SQLite——
 *   它是「这台机器上的这个人已被告知」,不是伙伴的权威数据;弹窗只出现
 *   一次,避免把每次进入都变成阻塞。
 * - key 不按数据主人分命名空间:AI 公示是设备级事实,换账号不重弹;
 *   换设备各自确认一次。
 */

const STORAGE_KEY = 'cindy.bots.aiDisclosureAck.v1';

export function isBotAiDisclosureAcknowledged(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // 存储不可用时按「未确认」处理:宁可多弹一次公示,不可漏公示。
    return false;
  }
}

export function acknowledgeBotAiDisclosure(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // 写入失败只影响「是否重弹」,不阻塞本次互动。
  }
}
