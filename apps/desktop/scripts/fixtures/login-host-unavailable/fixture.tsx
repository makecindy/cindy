import { LoginPage } from '../../../src/renderer/components/login/LoginPage';
import { mountPage } from '../../ui-page/harness';

void mountPage({ render: () => <LoginPage /> });
