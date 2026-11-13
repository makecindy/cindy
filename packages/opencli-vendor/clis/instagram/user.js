import { readInstagramJsonJs, runInstagramRead } from './_shared/read-response.js';
import { cli } from '@jackwener/opencli/registry';
cli({
    site: 'instagram',
    name: 'user',
    access: 'read',
    description: 'Get recent posts from an Instagram user',
    domain: 'www.instagram.com',
    args: [
        { name: 'username', required: true, positional: true, help: 'Instagram username' },
        { name: 'limit', type: 'int', default: 12, help: 'Number of posts' },
    ],
    columns: ['index', 'caption', 'likes', 'comments', 'type', 'date'],
    browser: true,
    navigateBefore: false,
    func: async (page, kwargs) => {
        await page.goto(`https://www.instagram.com/${encodeURIComponent(String(kwargs.username))}/`);
        return runInstagramRead(page, `(async () => {
  const username = ${JSON.stringify(kwargs.username)};
  const limit = ${JSON.stringify(kwargs.limit)};
  const headers = { 'X-IG-App-ID': '936619743392459' };
  ${readInstagramJsonJs()}
  const opts = { credentials: 'include', headers };

  // Fetch directly by username. web_profile_info is gated for some public
  // accounts even with a valid session, while this feed endpoint still returns
  // the same media item shape this command maps.
  const r2 = await fetch(
    'https://www.instagram.com/api/v1/feed/user/' + encodeURIComponent(username) + '/username/?count=' + limit,
    opts
  );
  if (!r2.ok) throw new Error('Instagram feed-by-username failed: HTTP ' + r2.status);
  const d2 = await readInstagramJson(r2, 'Instagram feed-by-username');
  if (!Array.isArray(d2.items)) throw new Error('Instagram feed returned malformed items');
  return d2.items.slice(0, limit).map((p, i) => ({
    index: i + 1,
    caption: (p.caption?.text || '').replace(/\\n/g, ' ').substring(0, 100),
    likes: p.like_count ?? 0,
    comments: p.comment_count ?? 0,
    type: p.media_type === 1 ? 'photo' : p.media_type === 2 ? 'video' : 'carousel',
    date: p.taken_at ? new Date(p.taken_at * 1000).toLocaleDateString() : '',
  }));
})()
`);
    },
});
