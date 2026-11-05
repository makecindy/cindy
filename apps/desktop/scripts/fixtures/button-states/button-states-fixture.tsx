import { mountPage } from '../../ui-page/harness';
import { Button } from '../../../src/renderer/components/ui/button';
import { SendButton } from '../../../src/renderer/components/new-chat/SendButton';

const ROWS = [
  { id: 'cta', title: 'cta', props: { variant: 'cta' }, label: '保存', hover: '--button-cta-hover', pressed: '--button-cta-pressed' },
  { id: 'danger', title: 'danger-solid', props: { tone: 'danger-solid' }, label: '删除', hover: '--button-danger-solid-hover', pressed: '--button-danger-solid-pressed' },
  { id: 'permission', title: 'permission', props: { palette: 'permission' }, label: '允许', hover: '--perm-allow-btn-hover', pressed: '--perm-allow-btn-pressed' },
  { id: 'confirmation', title: 'confirmation', props: { palette: 'confirmation', variant: 'cta' }, label: '确认', hover: '--confirm-btn-primary-hover', pressed: '--confirm-btn-primary-pressed' },
  { id: 'secondary', title: 'secondary', props: { variant: 'secondary' }, label: '取消', hover: '--button-secondary-hover', pressed: '--button-secondary-pressed' },
  { id: 'primary', title: 'primary', props: { variant: 'primary' }, label: '编辑', hover: '--button-primary-hover', pressed: '--button-primary-pressed' },
] as const;

const forced = (token: string) =>
  ({ '--button-face-bg': `var(${token})`, '--button-face-border': `var(${token})` }) as React.CSSProperties;

mountPage({
  render: () => (
    <div className="grid grid-cols-[120px_repeat(4,110px)] items-center gap-x-4 gap-y-3 p-6 text-13 text-[var(--text-primary)]">
      <span />
      <span>默认</span>
      <span>悬停（色值）</span>
      <span>按下（色值）</span>
      <span>真实指针</span>
      {ROWS.map((row) => (
        <div key={row.id} className="contents">
          <span>{row.title}</span>
          <Button {...row.props}>{row.label}</Button>
          <Button {...row.props} data-state-sample={`${row.id}-hover`} style={forced(row.hover)}>{row.label}</Button>
          <Button {...row.props} data-state-sample={`${row.id}-pressed`} style={forced(row.pressed)}>{row.label}</Button>
          <Button {...row.props} data-pointer={row.id}>{row.label}</Button>
        </div>
      ))}
      <span>SendButton</span>
      <SendButton disabled={false} onClick={() => {}} />
      <span data-send-sample="hover" className="inline-flex"><style>{'[data-send-sample="hover"] button{background:var(--send-btn-hover-bg)!important}[data-send-sample="pressed"] button{background:var(--send-btn-pressed-bg)!important}'}</style><SendButton disabled={false} onClick={() => {}} /></span>
      <span data-send-sample="pressed" className="inline-flex"><SendButton disabled={false} onClick={() => {}} /></span>
      <span data-pointer="send" className="inline-flex"><SendButton disabled={false} onClick={() => {}} /></span>
    </div>
  ),
});
