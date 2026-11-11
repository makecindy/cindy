import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const CHINA_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Format a Unix ms timestamp as the matching `YYYY-MM-DD` in Asia/Shanghai (xueqiu's canonical user timezone for all markets). */
export function formatChinaDate(ts) {
    if (ts == null) return null;
    const parts = Object.fromEntries(
        CHINA_DATE_FORMATTER.formatToParts(new Date(ts))
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function stripHtml(html) {
    return (html || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

/**
 * Fetch a xueqiu JSON API from inside the browser context (credentials included).
 * Page must already be navigated to xueqiu.com before calling this function.
 * Throws CliError on HTTP errors; otherwise returns the parsed JSON.
 */
export function responseSummary(response) {
    const json = response?.json;
    const keys = json && typeof json === 'object' && !Array.isArray(json)
        ? Object.keys(json).slice(0, 12).map(key => key.replace(/[^a-zA-Z0-9_]/g, '?').slice(0, 40)).join(',') : '';
    const type = String(response?.contentType ?? '').split(';')[0].replace(/[^a-zA-Z0-9/+.-]/g, '').slice(0, 80);
    return `HTTP ${Number(response?.status) || 0}; content-type=${type || 'unknown'}; JSON=${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json}; keys=[${keys}]`;
}

export async function fetchXueqiuJson(page, url) {
    let result;
    try {
        result = await page.evaluate(`(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: controller.signal });
                const text = await res.text();
                let json = null;
                try { json = JSON.parse(text); } catch {}
                const contentType = res.headers.get('content-type') || '';
                const html = contentType.includes('text/html') || /^\\s*</.test(text);
                const challenge = html && /captcha|challenge|aliyun_waf|安全验证|验证码|请登录/i.test(text);
                return { status: res.status, contentType, json, challenge };
            } finally { clearTimeout(timer); }
        })()`);
    } catch {
        throw new CommandExecutionError('Xueqiu page request failed (network, CSP or timeout)', 'Check the browser page and network; a working whoami does not prove this route is reachable.');
    }
    if (result && typeof result === 'object' && 'session' in result && 'data' in result) result = result.data;
    const summary = responseSummary(result);
    if (result?.status === 401 || result?.status === 403 || result?.challenge) {
        throw new AuthRequiredError('xueqiu.com', `Route requires login or challenge clearance (${summary})`);
    }
    if (!result || result.status < 200 || result.status >= 300 || !Number.isFinite(result.status)) {
        throw new CommandExecutionError(`Xueqiu request failed (${summary})`, 'For HTTP 429, wait before retrying.');
    }
    if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) {
        throw new CommandExecutionError(`Xueqiu response is not a JSON object (${summary})`, 'Inspect this request in browser Network; share only a sanitized response shape, without cookies or tokens.');
    }
    return result.json;
}
