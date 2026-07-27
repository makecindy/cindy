/**
 * Full access 确认弹窗的四语文案。
 *
 * 单独成模块是为了**能被术语门禁扫到**:这是不走 i18next 的手写四语 catalog,
 * check-i18n-glossary.mjs 只读 locale JSON 扫不到它。而它恰恰是全 App 风险最高的一处
 * 提示——用户在这里决定是否关掉工作区沙箱、跳过逐条批准,措辞含糊的代价很实在。
 *
 * 之所以不能留在 fullAccessConfirmation.ts 里被测试直接 import:那个文件 import 了
 * react-native,vitest 解析不了 RN 的 Flow 源码。
 *
 * 覆盖它的是 src/__tests__/shadowCatalogGlossary.test.ts。
 */

export type FullAccessConfirmationCopy = Readonly<{
  title: string;
  description: string;
  confirm: string;
  cancel: string;
}>;

export const FULL_ACCESS_CONFIRMATION_COPY: Record<'en' | 'ja' | 'ko' | 'zh', FullAccessConfirmationCopy> = {
  en: {
    title: 'Enable Full access?',
    description: 'Full access disables the workspace sandbox and skips routine approvals. Cindy can modify files outside the workspace and run network commands without asking; built-in high-risk operations will still require confirmation.',
    confirm: 'Enable Full access',
    cancel: 'Keep current permissions',
  },
  ja: {
    title: 'Full access を有効にしますか？',
    description: 'Full access はワークスペースのサンドボックスを無効にし、通常の承認を省略します。Cindy はワークスペース外のファイル変更やネットワークコマンドを確認なしで実行できます。組み込みの高リスク操作では引き続き確認が必要です。',
    confirm: 'Full access を有効にする',
    cancel: '現在の権限を維持',
  },
  ko: {
    title: 'Full access를 활성화할까요?',
    description: 'Full access는 작업 공간 샌드박스를 비활성화하고 일반 승인을 건너뜁니다. Cindy가 작업 공간 밖의 파일을 수정하고 네트워크 명령을 묻지 않고 실행할 수 있습니다. 기본 제공 고위험 작업은 계속 확인을 요청합니다.',
    confirm: 'Full access 활성화',
    cancel: '현재 권한 유지',
  },
  zh: {
    title: '开启 Full access？',
    description: 'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外的文件、执行联网命令且不再询问；内置高风险操作仍会要求确认。',
    confirm: '开启 Full access',
    cancel: '保留当前权限',
  },
};
