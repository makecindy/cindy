import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import zh from '../../../src/renderer/i18n/locales/zh-CN/common.json';
import '../../../src/renderer/themes/colors';
import { ThemeService } from '../../../src/renderer/themes/theme-service';
import { defaultLight } from '../../../src/renderer/themes/builtin/default-light';
import { defaultDark } from '../../../src/renderer/themes/builtin/default-dark';
import { CindyDeviceRow } from '../../../src/renderer/features/bots/CindyDeviceRow';
import { BotSessionContentHeader } from '../../../src/renderer/features/bots/BotSessionContentHeader';
import { cindyDeviceOptions } from '../../../src/renderer/features/bots/cindyDeviceRoster';
import { Select } from '../../../src/renderer/components/ui/select';

const query = new URLSearchParams(location.search);
const dark = query.get('theme') === 'dark';
new ThemeService().applyTheme(dark ? defaultDark : defaultLight);
document.documentElement.classList.toggle('dark', dark);
await i18next.use(initReactI18next).init({
  lng: 'zh-CN',
  resources: { 'zh-CN': { translation: zh } },
});

// Only roster hooks are stubbed by the runner; geometry, Radix and routing are real.
const data = (window as any).devicePickerFixture;
const options = cindyDeviceOptions(data.bots, data.remoteBots, data.devices, data.unread, '本机');
function App() {
  const [current, setCurrent] = useState(options[query.has('long') ? 1 : 0]);
  const [opens, setOpens] = useState(0);
  const [selections, setSelections] = useState(0);
  const route = useLocation();
  return (
    <>
      <p className="fixture-caption">
        {query.get('stage')} · {dark ? 'Dark' : 'Light'} · 生产组件浏览器验证（非实机）
      </p>
      <div className="fixture-layout">
        <aside>
          <CindyDeviceRow
            current={current}
            options={options}
            selected={!query.has('unselected')}
            subtitle="已整理好今天的安排。"
            timestamp="13:56"
            onOpen={() => setOpens((count) => count + 1)}
            onSelect={(option) => {
              setCurrent(option);
              setSelections((count) => count + 1);
            }}
          />
        </aside>
        <main>
          <header>
            <BotSessionContentHeader bot={options[query.has('long') ? 1 : 0].bot} />
          </header>
          <section className="fixture-results">
            <output data-testid="opens">{opens}</output>
            <output data-testid="selections">{selections}</output>
            <output data-testid="route">{route.pathname}</output>
            <div data-testid="ordinary-select" style={{ width: 180 }}>
              <Select
                label="普通选择器"
                value="one"
                options={[{ value: 'one', label: '普通选项' }]}
                onValueChange={() => {}}
                className="w-full"
              />
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <App />
  </MemoryRouter>,
);
