import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { authErrorMessages, loginMessages } from '@/auth/loginMessages';
import { parseLegalSegments } from '@/auth/legalText';
import ru from '@/i18n/locales/ru';
import { isLocalePreference, resolveSystemLocale } from '@/i18n/locale';
import { newSessionMessages } from '@/session/newSessionMessages';

describe('ru 移动端语言', () => {
  it.each(['consentStatement', 'consentDialogBody'] as const)('%s 的两个法律链接都可点击', (key) => {
    const links = parseLegalSegments(loginMessages.ru[key]).filter((segment) => segment.kind !== 'text');
    expect(links.map((segment) => segment.kind)).toEqual(['terms', 'privacy']);
    for (const link of links) expect(link.text.trim().length).toBeGreaterThan(0);
  });

  it.each(['ru', 'ru-RU', 'RU_by', 'ru-KZ'])('识别系统语言 %s', (tag) => {
    expect(resolveSystemLocale(tag)).toBe('ru');
  });

  it('保存的语言偏好与不经过 i18next 的界面文案都可用', () => {
    expect(isLocalePreference('ru')).toBe(true);
    expect(loginMessages.ru.title).toBe('Войти в Cindy');
    expect(newSessionMessages.ru.emptyDirectory).toContain('папок');
    for (const error of Object.values(authErrorMessages)) expect(error.ru).toBeTruthy();
  });

  it('按俄语复数规则处理整数与小数计数', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: 'ru', resources: { ru: { translation: ru } } });
    const cases = [
      [1, 'участник'],
      [2, 'участника'],
      [5, 'участников'],
      [11, 'участников'],
      [21, 'участник'],
      [1.5, 'участника'],
    ] as const;
    for (const [count, word] of cases) {
      expect(i18n.t('groupChat.memberCount', { count })).toBe(`${count} ${word}`);
    }
  });
});
