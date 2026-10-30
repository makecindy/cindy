import React from 'react';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import '../../../src/renderer/themes/colors';
import { themeService } from '../../../src/renderer/themes/theme-service';
import { defaultLight } from '../../../src/renderer/themes/builtin/default-light';
import { defaultDark } from '../../../src/renderer/themes/builtin/default-dark';
import zh from '../../../src/renderer/i18n/locales/zh-CN/common.json';
import { ThinkingCard } from '../../../src/renderer/components/chat/ThinkingCard';
import { WorkGroupBlock } from '../../../src/renderer/components/chat/WorkGroupBlock';
const mode = new URLSearchParams(location.search).get('theme') ?? 'light';
(window as any).electronAPI = { platform: 'darwin', logToMain() {} };
(window as any).fixture = { calls: 0, fail: false };
themeService.applyTheme(mode === 'dark' ? defaultDark : defaultLight);
await i18n
  .use(initReactI18next)
  .init({
    lng: 'zh-CN',
    defaultNS: 'common',
    resources: { 'zh-CN': { common: zh } },
    interpolation: { escapeValue: false },
  });
const source =
  '**Reviewing the implementation**\nI will inspect `main.ts`, then compare the results. This is a tentative plan, not a confirmed outcome.';
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24, maxWidth: 800, margin: 'auto' }}>
    <p style={{ marginBottom: 24 }}>
      思考翻译 · {mode === 'dark' ? 'Dark' : 'Light'} · 合成测试内容
    </p>
    <section data-case="standalone">
      <ThinkingCard blockKey="standalone" content={source} durationMs={1200} />
    </section>
    <section data-case="group" style={{ marginTop: 24 }}>
      <WorkGroupBlock
        blockId="work-fixture"
        durationMs={2800}
        childItems={[
          {
            kind: 'thinking',
            key: 'group-thinking',
            message: {
              clientId: 'group-thinking',
              role: 'thinking',
              content: source,
              isStreaming: false,
            } as any,
          },
        ]}
      />
    </section>
    <section data-case="empty" style={{ marginTop: 24 }}>
      <ThinkingCard blockKey="empty" content="" durationMs={800} />
    </section>
    <section data-case="hidden" style={{ marginTop: 16 }}>
      <ThinkingCard blockKey="hidden" content="" isRedacted />
    </section>
  </main>,
);
