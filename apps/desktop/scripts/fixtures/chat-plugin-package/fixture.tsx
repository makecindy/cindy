import { mountPage } from '../../ui-page/harness';
import { RichAnswer } from '../../../src/renderer/components/chat/RichAnswer';
import { GeneratedPluginPackage } from '../../../src/renderer/components/chat/GeneratedPluginPackage';
import { SessionQuickSendProvider } from '../../../src/renderer/components/chat/SessionQuickSendContext';
const manifest = { id: 'black-cat-club', name: '煤球值班室', version: '1.0.2' };
const source = JSON.stringify({
  seq: 1,
  version: 1,
  op: 'create',
  id: 'install',
  kind: 'button',
  props: { label: '安装到 Cindy', send: '把这版「煤球值班室」安装到当前 Cindy。' },
});
void mountPage({
  route: '/cc-agent/preview',
  cases: ['default', 'before'],
  host: {
    ghosts: {
      inspect: async () => ({ manifest, packageSha256: '1'.repeat(64) }),
      listSync: () => ({ ghosts: [] }),
      onChanged: () => () => {},
    },
  },
  render: (ctx) => (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6 py-5">
      <p className="text-15 text-[var(--text-primary)]">「煤球值班室」已打包，可以安装到 Cindy。</p>
      {ctx.case === 'before' ? (
        <SessionQuickSendProvider value={{ send: async () => true }}>
          <RichAnswer
            complete
            source={source}
            stateKey="comparison"
            renderMarkdown={(text) => text}
          />
        </SessionQuickSendProvider>
      ) : (
        <GeneratedPluginPackage sessionId="test" path="black-cat-club-1.0.2.cindy">
          <span>black-cat-club-1.0.2.cindy</span>
        </GeneratedPluginPackage>
      )}
    </main>
  ),
});
