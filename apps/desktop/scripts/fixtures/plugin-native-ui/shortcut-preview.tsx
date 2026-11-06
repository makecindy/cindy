import { useEffect, useRef } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { KeyboardShortcutsSection } from '../../../src/renderer/components/settings/KeyboardShortcutsSection';

function Preview() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current?.scrollTo(0, container.current.scrollHeight);
  }, []);
  return <main ref={container} className="h-screen overflow-y-auto p-4">
    <KeyboardShortcutsSection />
  </main>;
}

const definition = {
  id: `plugin:${'a'.repeat(64)}`,
  label: 'Format message',
  pluginName: 'Writer',
  scope: 'message',
  defaultCombo: { code: 'KeyJ', meta: false, ctrl: false, alt: true, shift: true },
};

mountPage({
  host: {
    appShortcuts: {
      getState: () => ({ platform: 'darwin', overrides: {}, pluginShortcuts: [definition] }),
      onChanged: subscription('shortcutsChanged'),
    },
  },
  render: () => <Preview />,
});
