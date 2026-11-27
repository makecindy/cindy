import { LoginPageView } from '../../../src/renderer/components/login/LoginPage';
import type { useLogin } from '../../../src/renderer/hooks/useLogin';
import type { DesktopLoginState } from '../../../src/shared/authIpc';
import { mountPage, type UiPageContext } from '../../ui-page/harness';

type Login = ReturnType<typeof useLogin>;

/** 场景数据只给 step 名与渠道；邮箱是示例数据。 */
function stateFor(ctx: UiPageContext): DesktopLoginState {
  const data = ctx.data as { step: string; channel?: string };
  switch (data.step) {
    case 'identifier':
      return {
        step: 'identifier',
        providers: { region: 'global', attribution: 'email', email: true, phone: false, social: ['apple', 'google'] },
      };
    case 'signup-confirmation':
      return data.channel === 'email'
        ? { step: 'signup-confirmation', channel: 'email', targetMasked: 'a***@example.com' }
        : { step: 'signup-confirmation', channel: data.channel ?? 'google' };
    default:
      throw new Error(`unknown step ${data.step}`);
  }
}

void mountPage({
  render: (ctx) => {
    const login: Login = {
      isLoading: false,
      errorCode: null,
      retryAt: undefined,
      loginState: stateFor(ctx),
      credentialStoreUnavailable: false,
      hostUnavailableReason: null,
      hasAccountDeletionReceipt: false,
      getAccountDeletionStatus: async () => null,
      clearAccountDeletionReceipt: async () => {},
      listAccounts: async () => [],
      dispatch: async () => false,
      dispatchWithResult: async () => ({ success: false, code: 'UI_PAGE_FIXTURE', state: null }),
      clearError: () => {},
      enterLocalMode: null,
    } as unknown as Login;
    return <LoginPageView login={login} />;
  },
});
