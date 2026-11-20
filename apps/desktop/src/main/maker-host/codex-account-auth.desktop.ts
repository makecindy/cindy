import { app } from 'electron';
import { getCachedBinaryStatus, isVettedAgentBinaryPath } from '../agent-binaries/index.js';
import { broadcastCodexAccountAuthReady, broadcastCodexAccountAuthStarted } from '../usageBroadcaster.js';
import { createCodexAccountAuth } from './codex-account-auth.js';
export { parseCodexAccountIdentity } from './codex-auth-identity.js';
export const { isCodexAccountProvider, isOpenAiSubscriptionProviderId, invalidateCodexAccount, codexAccountOwnerDir, codexAccountHome, codexAccountLoginName, codexAccountState, prepareCodexAccountHome, setCodexAccountRetirement, cancelCodexAccountLogin, loginCodexAccount, logoutCodexAccount, retireCodexAccount, removeCodexAccountCredentialsReversibly } = createCodexAccountAuth({
  getUserDataDir: () => app.getPath('userData'),
  getCodexBinary: () => {
    const binary = getCachedBinaryStatus('codex');
    return binary.binaryPath && isVettedAgentBinaryPath('codex', binary.binaryPath) ? binary.binaryPath : null;
  },
  broadcastCodexAccountAuthReady: providerId => broadcastCodexAccountAuthReady(providerId),
  broadcastCodexAccountAuthStarted: providerId => broadcastCodexAccountAuthStarted(providerId),
});
