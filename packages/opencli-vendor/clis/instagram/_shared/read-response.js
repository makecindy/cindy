import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

export function readInstagramJsonJs() {
    return `
    async function readInstagramJson(response, label) {
        let text;
        try { text = await response.text(); }
        catch { throw new Error(label + ' response body could not be read'); }
        let data;
        try { data = JSON.parse(text); }
        catch {
            const html = /^\\s*</.test(text);
            const challenge = html && /challenge_required|checkpoint|captcha|login_required|accounts\\/login/i.test(text);
            const error = new Error(label + (html ? ' returned HTML instead of JSON' : ' returned invalid JSON') + ' (HTTP ' + response.status + ')');
            if (challenge) error.code = 'AUTH_REQUIRED';
            throw error;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(label + ' returned malformed JSON');
        if (data.status === 'fail' || data.message === 'login_required' || data.challenge) {
            const error = new Error(label + ' returned an API failure');
            if (data.challenge || /login_required|challenge_required|checkpoint_required/.test(String(data.message || ''))) error.code = 'AUTH_REQUIRED';
            throw error;
        }
        return data;
    }
    `;
}

export async function runInstagramRead(page, script) {
    let result;
    try {
        result = await page.evaluate(`(async () => {
            try { return { rows: await (${script}) }; }
            catch (error) { return { failure: { code: error.code, message: String(error.message || error) } }; }
        })()`);
    } catch {
        throw new CommandExecutionError('Instagram page request failed (network or browser context)', 'Check the Instagram page and retry after any temporary restriction clears.');
    }
    if (result && typeof result === 'object' && 'session' in result && 'data' in result) result = result.data;
    if (result?.failure) {
        const message = result.failure.message;
        if (result.failure.code === 'AUTH_REQUIRED' || /HTTP (401|403)\b/.test(message)) {
            throw new AuthRequiredError('www.instagram.com', message);
        }
        throw new CommandExecutionError(message, /HTTP 429\b/.test(message)
            ? 'Instagram rate-limited this route. Wait before retrying; no automatic retry or fallback was attempted.'
            : 'Inspect this route in browser Network. Share a sanitized response shape without cookies or tokens.');
    }
    if (!Array.isArray(result?.rows)) throw new CommandExecutionError('Instagram returned an invalid read result');
    return result.rows;
}
