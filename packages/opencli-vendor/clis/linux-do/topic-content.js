import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { BROWSER_JSON_SNIFF_FN, htmlToMarkdown, isRecord, throwIfLoginWall } from '@jackwener/opencli/utils';
import { toLocalTime } from './format.js';
const LINUX_DO_DOMAIN = 'linux.do';
const LINUX_DO_HOME = 'https://linux.do';
function normalizeTopicPayload(payload) {
    if (!isRecord(payload))
        return null;
    const postStream = isRecord(payload.post_stream)
        ? {
            posts: Array.isArray(payload.post_stream.posts)
                ? payload.post_stream.posts.filter(isRecord).map((post) => ({
                    post_number: typeof post.post_number === 'number' ? post.post_number : undefined,
                    username: typeof post.username === 'string' ? post.username : undefined,
                    raw: typeof post.raw === 'string' ? post.raw : undefined,
                    cooked: typeof post.cooked === 'string' ? post.cooked : undefined,
                    like_count: typeof post.like_count === 'number' ? post.like_count : undefined,
                    created_at: typeof post.created_at === 'string' ? post.created_at : undefined,
                }))
                : undefined,
        }
        : undefined;
    return {
        title: typeof payload.title === 'string' ? payload.title : undefined,
        post_stream: postStream,
    };
}
function buildTopicMarkdownDocument(params) {
    const frontMatterLines = [];
    const entries = [
        ['title', params.title || undefined],
        ['author', params.author || undefined],
        ['likes', typeof params.likes === 'number' && Number.isFinite(params.likes) ? params.likes : undefined],
        ['createdAt', params.createdAt || undefined],
        ['url', params.url || undefined],
    ];
    for (const [key, value] of entries) {
        if (value === undefined)
            continue;
        if (typeof value === 'number') {
            frontMatterLines.push(`${key}: ${value}`);
        }
        else {
            // Quote strings that could be misinterpreted by YAML parsers
            const needsQuote = /[#{}[\],&*?|>!%@`'"]/.test(value) || /: /.test(value) || /:$/.test(value) || value.includes('\n');
            frontMatterLines.push(`${key}: ${needsQuote ? `'${value.replace(/'/g, "''")}'` : value}`);
        }
    }
    const frontMatter = frontMatterLines.join('\n');
    return [
        frontMatter ? `---\n${frontMatter}\n---` : '',
        params.body.trim(),
    ].filter(Boolean).join('\n\n').trim();
}
function extractTopicContent(payload, id) {
    const topic = normalizeTopicPayload(payload);
    if (!topic) {
        throw new CommandExecutionError('linux.do returned an unexpected topic payload');
    }
    const posts = topic.post_stream?.posts ?? [];
    const mainPost = posts.find((post) => post.post_number === 1);
    if (!mainPost) {
        throw new EmptyResultError('linux-do/topic-content', `Could not find the main post for topic ${id}.`);
    }
    const body = typeof mainPost.raw === 'string' && mainPost.raw.trim()
        ? mainPost.raw.trim()
        : htmlToMarkdown(mainPost.cooked ?? '');
    if (!body) {
        throw new EmptyResultError('linux-do/topic-content', `Topic ${id} does not contain a readable main post body.`);
    }
    return {
        content: buildTopicMarkdownDocument({
            title: topic.title?.trim() ?? '',
            author: mainPost.username?.trim() ?? '',
            likes: typeof mainPost.like_count === 'number' ? mainPost.like_count : undefined,
            createdAt: toLocalTime(mainPost.created_at ?? ''),
            url: `${LINUX_DO_HOME}/t/${id}`,
            body,
        }),
    };
}
async function fetchTopicPayload(page, id) {
    const result = await page.evaluate(`(async () => {
    ${BROWSER_JSON_SNIFF_FN}
    try {
      const payload = await fetchJsonOrLoginWall('/t/${id}.json?include_raw=true', { credentials: 'include' });
      if (payload?.__loginWall) return { kind: 'login-wall', sentinel: payload };
      if (payload?.error) return { kind: 'http', status: payload.error };
      return { kind: 'ok', data: payload };
    } catch (error) {
      return { kind: 'exception', detail: error instanceof Error ? error.message : String(error) };
    }
  })()`);
    if (!result) {
        throw new CommandExecutionError('linux.do returned an empty browser response');
    }
    if (result.kind === 'login-wall') {
        throwIfLoginWall(result.sentinel, { url: `/t/${id}.json?include_raw=true` });
    }
    if (result.kind === 'http') {
        if (typeof result.status !== 'number') {
            throw new CommandExecutionError(`linux.do topic ${id} response reported a non-numeric HTTP status.`);
        }
        if (result.status === 401 || result.status === 403) {
            throw new AuthRequiredError(LINUX_DO_DOMAIN, `linux.do returned HTTP ${result.status}`);
        }
        const hint = result.status === 429
            ? 'Stop retrying this channel and wait for the channel cooldown.'
            : undefined;
        throw new CommandExecutionError(`linux.do topic ${id} request failed: HTTP ${result.status ?? 'unknown'}`, hint);
    }
    if (result.kind === 'exception') {
        throw new CommandExecutionError(`linux.do topic ${id} request failed: ${result.detail}`);
    }
    if (result.kind !== 'ok') {
        throw new CommandExecutionError(`Unexpected linux.do topic response: ${JSON.stringify(result)}`);
    }
    return result.data;
}
cli({
    site: 'linux-do',
    name: 'topic-content',
    access: 'read',
    description: 'Get the main topic body as Markdown',
    domain: LINUX_DO_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    defaultFormat: 'plain',
    args: [
        { name: 'id', positional: true, type: 'int', required: true, help: 'Topic ID' },
    ],
    columns: ['content'],
    func: async (page, kwargs) => {
        const id = Number(kwargs.id);
        if (!Number.isInteger(id) || id <= 0) {
            throw new CommandExecutionError(`Invalid linux.do topic id: ${String(kwargs.id ?? '')}`);
        }
        const payload = await fetchTopicPayload(page, id);
        return [extractTopicContent(payload, id)];
    },
});
export const __test__ = {
    buildTopicMarkdownDocument,
    extractTopicContent,
    normalizeTopicPayload,
};
