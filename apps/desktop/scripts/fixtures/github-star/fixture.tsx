import { useEffect, useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { Toast } from '../../../src/renderer/components/ui/toast/Toast';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';
import { Button } from '../../../src/renderer/components/ui/button';
import { showGithubStarPrompt } from '../../../src/renderer/lib/githubStarPrompt';
import { useTheme } from '../../../src/renderer/hooks/useTheme';
import i18n from '../../../src/renderer/i18n';
import { QuotaResetPreview } from './QuotaResetPreview';

let simulateSuccess = true;

function InteractivePreview() {
  const [round, setRound] = useState(0);
  const [success, setSuccess] = useState(true);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    let current = true;
    const close = showGithubStarPrompt(() => {}, () => current);
    return () => { current = false; close(); };
  }, [round]);
  const replay = (succeeds: boolean) => {
    simulateSuccess = succeeds;
    setSuccess(succeeds);
    setRound(value => value + 1);
  };
  return <>
    <ToastContainer />
    <QuotaResetPreview />
    <div data-ui-page-control className="absolute inset-x-0 bottom-40 px-6 flex flex-col items-center gap-3 text-sm text-muted-foreground">
      <p>点击上方 Star 按钮，体验完整流程。</p>
      <p>{success ? '模拟成功：处理中 → 礼花 → 感谢提示' : '模拟失败：转到 GitHub → 浏览器打开失败 → 可重试'}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" data-preview-replay onClick={() => replay(true)}>重新体验</Button>
        <Button variant="secondary" data-preview-failure onClick={() => replay(false)}>体验失败状态</Button>
        <Button variant="secondary" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>切换深浅色</Button>
      </div>
      <p className="text-xs">独立预览 · 模拟 GitHub 结果 · 不会操作你的账号</p>
    </div>
  </>;
}

function StarPreview({ name }: { name: string }) {
  const [burst, setBurst] = useState(0);
  const celebration = name.startsWith('celebration');
  const success = name === 'success' || (celebration && burst > 0);
  const busy = name === 'busy';
  const fallback = name === 'fallback' || name === 'open-failed';
  const messageKey = success ? 'githubStar.thanksDescription'
    : name === 'open-failed' ? 'githubStar.openFailed'
    : fallback ? 'githubStar.browserFallback' : 'githubStar.description';
  return <div className="p-4 flex flex-col items-center gap-4">
    {celebration && <button data-ui-page-control data-preview-celebration onClick={() => setBurst(value => value + 1)}>预览礼花</button>}
    <Toast key={burst} item={{
      id: 'star-preview', variant: success ? 'success' : 'info', placement: 'top-right',
      title: i18n.t(success ? 'githubStar.thanks' : 'githubStar.title'),
      message: i18n.t(messageKey), celebrate: celebration && success,
      icon: success ? undefined : 'star', duration: 0, createdAt: 0, exiting: false,
      dismissLabel: success ? undefined : i18n.t('githubStar.dismiss'),
      action: success ? undefined : { label: i18n.t(busy ? 'githubStar.starring' : fallback ? 'githubStar.openGithub' : 'githubStar.action'), emphasis: 'cta', disabled: busy, keepOpen: true, onClick() {} },
    }} />
  </div>;
}
mountPage({
  host: {
    gitContext: {
      starCindy: async () => {
        const result = simulateSuccess;
        await new Promise(resolve => setTimeout(resolve, 800));
        return result;
      },
    },
    openExternal: async () => ({ success: false }),
  },
  render: (ctx) => ctx.case === 'interactive' ? <InteractivePreview /> : ctx.case.startsWith('quota') ? <QuotaResetPreview /> : <StarPreview name={ctx.case} />,
});
