import { dblpFetchXml } from './browser.js';
/**
 * dblp record detail.
 *
 * Fetches a single record's XML metadata at `/rec/<key>.xml` and projects
 * it into a one-row table. The XML payload is small (<1KB typical) and
 * uses a stable, narrow schema, so we parse it with conservative regexes
 * — same approach as the arxiv adapter.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import {
    PAPER_COLUMNS,
    recordXmlToRow,
    requireRecordKey,
} from './utils.js';

cli({
    site: 'dblp',
    name: 'paper',
    aliases: ['detail', 'view'],
    access: 'read',
    description: 'Fetch a dblp record by canonical key (e.g. conf/nips/VaswaniSPUJGKP17)',
    domain: 'dblp.org',
    strategy: Strategy.PUBLIC,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'key', positional: true, required: true, help: 'dblp record key (round-tripped from the `key` column of `dblp search`)' },
    ],
    columns: PAPER_COLUMNS,
    func: async (page, args) => {
        const key = requireRecordKey(args.key);
        const xml = await dblpFetchXml(page, `/rec/${encodeURI(key)}.xml`, 'dblp paper');
        const row = recordXmlToRow(xml);
        if (!row.key && !row.title) {
            throw new EmptyResultError('dblp paper', `dblp returned an empty record for key "${key}".`);
        }
        return [row];
    },
});
