// Adapted from ZhongQuinnKing/opencli-douyin-detail (MIT). See detail.LICENSE.
/**
 * Douyin detail — 单条视频全解（分享短链 / 视频链接 / 纯数字 ID）。
 *
 * 设计（2026-10-06）：
 *   1) 输入归一：v.douyin.com 短链跟随重定向拿 ID；也接受 www.douyin.com/video/<id>、
 *      iesdouyin 分享页、modal_id、纯数字 ID。
 *   2) 关键：/aweme/v1/web/aweme/detail/ 必须在已登录页面上下文里 fetch ——
 *      抖音网页 JS 会给同源 /aweme/ 请求自动附签名（a_bogus/msToken），从 Node 直接打会被风控。
 *   3) 输出含 video.play_addr（无水印下载地址）、images（图文帖图集）、author.sec_uid
 *      （可直接接内置命令 `opencli douyin user-videos <sec_uid>`）。
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

import { browserFetch } from './_shared/browser-fetch.js';

const ID = /^\d{16,20}$/;
const HOSTS = new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com']);
function trustedUrl(input, base) {
    let url;
    try { url = new URL(input, base); }
    catch { throw new ArgumentError('Expected a Douyin video ID or URL'); }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password) {
        throw new ArgumentError('Only HTTPS Douyin share/video URLs are supported');
    }
    return url;
}
export function extractVideoId(input) {
    const text = String(input ?? '').trim();
    if (ID.test(text)) return text;
    const url = trustedUrl(text);
    if (url.hostname === 'v.douyin.com') return '';
    const pathId = url.pathname.match(/^\/(?:share\/)?video\/(\d{16,20})\/?$/)?.[1];
    const modalId = url.searchParams.get('modal_id');
    return pathId || (ID.test(modalId ?? '') ? modalId : '');
}
export async function resolveToId(input) {
    const text = String(input ?? '').trim();
    let id = extractVideoId(text);
    if (id) return id;
    let url = trustedUrl(text);
    if (url.hostname !== 'v.douyin.com') throw new ArgumentError('No video ID in Douyin URL');
    const visited = new Set();
    for (let hop = 0; hop < 6; hop++) {
        if (visited.has(url.href)) throw new CommandExecutionError('Douyin share URL redirect loop');
        visited.add(url.href);
        let res;
        try {
            res = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
            await res.body?.cancel();
        } catch (error) {
            throw new CommandExecutionError(`Douyin share URL request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (![301, 302, 303, 307, 308].includes(res.status)) {
            throw new CommandExecutionError(`Douyin share URL did not redirect (HTTP ${res.status})`);
        }
        const location = res.headers.get('location');
        if (!location) throw new CommandExecutionError('Douyin share redirect has no Location');
        url = trustedUrl(location, url);
        id = extractVideoId(url.href);
        if (id) return id;
    }
    throw new CommandExecutionError('Douyin share URL exceeded six redirects');
}

function fmtTime(ts) {
    if (!ts) return '';
    try { return new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' '); } catch { return String(ts); }
}

cli({
    site: 'douyin',
    name: 'detail',
    access: 'read',
    description: '单条视频全解（短链/链接/ID → 文案、互动数据、作者、下载地址、图文图集）',
    domain: 'www.douyin.com',
    strategy: Strategy.COOKIE,
    browser: true,
    example: 'opencli douyin detail "https://v.douyin.com/xxxx/" -f yaml',
    args: [
        { name: 'target', required: true, positional: true, help: '分享短链 / 视频链接 / 纯数字 ID' },
    ],
    columns: ['aweme_id', 'desc', 'author', 'author_sec_uid', 'digg', 'comment', 'collect', 'share', 'created', 'duration_s', 'music', 'play_url', 'cover', 'images', 'share_url'],
    func: async (page, kwargs) => {
        const target = String(kwargs.target ?? '').trim();
        if (!target) throw new ArgumentError('douyin detail 需要 <分享短链/链接/ID>');
        const id = await resolveToId(target);
        if (!id) throw new ArgumentError(`没能从输入里解析出视频 ID: ${target}`);
        await page.goto(`https://www.douyin.com/video/${id}`);
        await page.wait({ time: 2.5 });
        const params = new URLSearchParams({ aweme_id: id, aid: '6383' });
        const data = await browserFetch(page, 'GET', `https://www.douyin.com/aweme/v1/web/aweme/detail/?${params.toString()}`);
        const d = data.aweme_detail;
        if (!d) throw new EmptyResultError('douyin detail', `视频 ${id} 未返回详情（可能已删除或受限）`);
        if (typeof d !== 'object' || Array.isArray(d) || d.aweme_id !== id) {
            throw new CommandExecutionError('Douyin detail response has an invalid or mismatched aweme_id');
        }
        if (d.images != null && !Array.isArray(d.images)) throw new CommandExecutionError('Malformed Douyin image list');
        const st = d.statistics || {};
        return [{
            aweme_id: id,
            desc: d.desc ?? '',
            author: d.author?.nickname ?? '',
            author_sec_uid: d.author?.sec_uid ?? '',
            digg: st.digg_count ?? 0,
            comment: st.comment_count ?? 0,
            collect: st.collect_count ?? 0,
            share: st.share_count ?? 0,
            created: fmtTime(d.create_time),
            duration_s: Math.round((d.video?.duration ?? 0) / 1000),
            music: d.music?.title ?? '',
            play_url: d.video?.play_addr?.url_list?.[0] ?? '',
            cover: d.video?.cover?.url_list?.[0] ?? '',
            images: (d.images ?? []).map((im) => im?.url_list?.[0] ?? '').filter(Boolean),
            share_url: d.share_url ?? '',
        }];
    },
});
