import { readInstagramJsonJs, runInstagramRead } from './_shared/read-response.js';
import { cli } from '@jackwener/opencli/registry';
cli({
    site: 'instagram',
    name: 'search',
    access: 'read',
    description: 'Search Instagram users',
    domain: 'www.instagram.com',
    args: [
        { name: 'query', required: true, positional: true, help: 'Search query' },
        { name: 'limit', type: 'int', default: 10, help: 'Number of results' },
    ],
    columns: ['rank', 'username', 'name', 'verified', 'private', 'url', 'avatar_url'],
    browser: true,
    navigateBefore: false,
    func: async (page, kwargs) => {
        await page.goto('https://www.instagram.com/');
        return runInstagramRead(page, `(async () => {
  const query = ${JSON.stringify(kwargs.query)};
  const limit = ${JSON.stringify(kwargs.limit)};
  ${readInstagramJsonJs()}
  const res = await fetch(
    'https://www.instagram.com/web/search/topsearch/?query=' + encodeURIComponent(query) + '&context=user',
    {
      credentials: 'include',
      headers: { 'X-IG-App-ID': '936619743392459' }
    }
  );
  if (!res.ok) throw new Error('Instagram search failed: HTTP ' + res.status);
  const data = await readInstagramJson(res, 'Instagram search');
  if (!Array.isArray(data.users)) throw new Error('Instagram search returned malformed users');
  const users = data.users.slice(0, limit);
  return users.map((item, i) => ({
    rank: i + 1,
    username: item.user?.username || '',
    name: item.user?.full_name || '',
    verified: item.user?.is_verified ? 'Yes' : 'No',
    private: item.user?.is_private ? 'Yes' : 'No',
    avatar_url: typeof item.user?.profile_pic_url === 'string' && item.user.profile_pic_url.startsWith('https://') ? item.user.profile_pic_url : '',
    url: 'https://www.instagram.com/' + (item.user?.username || ''),
  }));
})()
`);
    },
});
