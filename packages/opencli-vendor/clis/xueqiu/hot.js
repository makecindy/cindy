import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli } from '@jackwener/opencli/registry';
import { fetchXueqiuJson, stripHtml as strip } from './utils.js';
cli({
    site: 'xueqiu',
    name: 'hot',
    access: 'read',
    description: '获取雪球热门动态',
    domain: 'xueqiu.com',
    browser: true,
    args: [
        { name: 'limit', type: 'int', default: 20, help: '返回数量，默认 20，最大 50' },
    ],
    columns: ['rank', 'author', 'text', 'likes', 'url'],
    func: async (page, kwargs) => {
        await page.goto('https://xueqiu.com');
        const d = await fetchXueqiuJson(page, 'https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1');
        if (!Array.isArray(d.list)) throw new CommandExecutionError('Xueqiu hot response is missing the list array', 'Inspect the request in browser Network and share a sanitized response shape.');
        return d.list.slice(0, kwargs.limit).map((item, i) => {
            const user = item.user || {};
            return {
                rank: i + 1,
                author: user.screen_name,
                text: strip(item.description).substring(0, 200),
                likes: item.fav_count,
                url: 'https://xueqiu.com/' + user.id + '/' + item.id,
            };
        });
    },
});
