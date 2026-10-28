import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { registerSiteAuthCommands } from '../_shared/site-auth.js';

// Confirmed in Ctrip's current homepage header (mfe_compose): the member
// summary, not the legacy login_uid cookie, drives its signed-in state.
const MEMBER_PROBE = `(async () => {
  try {
    const res = await fetch('https://m.ctrip.com/restapi/soa2/15201/getMemberSummaryInfo', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'Online', clientVersion: '99.99' }),
    });
    if (res.status === 401) return { kind: 'auth' };
    if (!res.ok) return { kind: 'http', httpStatus: res.status };
    const data = await res.json();
    const status = data?.ResponseStatus || data?.responseStatus;
    const errors = status?.Errors || [];
    if (errors.some(error =>
      (error.ErrorCode === 'AccountsMobileRequestFilterException' && /cookie auth is null/i.test(error.Message || '')) ||
      (error.ErrorFields || []).some(field => String(field.ErrorCode) === '201')
    )) return { kind: 'auth' };
    const memberGrade = data?.memberAssetSummaries?.find(item => item.assetType === 'UserGrade');
    if (status?.Ack !== 'Success' || !memberGrade) return { kind: 'shape' };
    return { ok: true, user_id: String(data.uid || ''), name: String(data.userName || ''), vip_grade: String(data.grade ?? '') };
  } catch (error) {
    return { kind: 'exception' };
  }
})()`;

async function probeCtripIdentity(page) {
  const result = await page.evaluate(MEMBER_PROBE);
  if (result?.kind === 'auth') throw new AuthRequiredError('ctrip.com', 'Ctrip member service requires login');
  if (result?.kind === 'http') throw new CommandExecutionError(`Ctrip member service returned HTTP ${result.httpStatus}`);
  if (!result?.ok) throw new CommandExecutionError('Ctrip member service could not verify the account; retry after checking the site in your browser');
  return { user_id: result.user_id, name: result.name, vip_grade: result.vip_grade };
}

async function verifyCtripIdentity(page) {
  await page.goto('https://www.ctrip.com/');
  await page.wait(2);
  return probeCtripIdentity(page);
}

registerSiteAuthCommands({
  site: 'ctrip',
  domain: 'ctrip.com',
  loginUrl: 'https://passport.ctrip.com/user/login?backurl=https%3A%2F%2Fwww.ctrip.com%2F',
  columns: ['user_id', 'name', 'vip_grade'],
  // Cookie presence cannot prove a valid session. Quick status stays unknown.
  verify: verifyCtripIdentity,
  poll: async (page) => {
    const onHome = await page.evaluate(`location.hostname === 'www.ctrip.com'`);
    if (!onHome) throw new AuthRequiredError('ctrip.com', 'Waiting for Ctrip login to return to the homepage');
    return probeCtripIdentity(page);
  },
});
