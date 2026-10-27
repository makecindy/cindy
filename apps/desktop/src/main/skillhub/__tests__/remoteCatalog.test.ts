import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRemoteSkillCatalog } from '../remoteCatalog';
import type { SkillhubMarketService } from '../marketService';

const service = {
  listMarket: vi.fn(),
  listCategories: vi.fn(),
  info: vi.fn(),
  getPublishedFiles: vi.fn(),
  readPublishedFile: vi.fn(),
  getScanStatus: vi.fn(),
};
const read = (input: Record<string, unknown>) =>
  readRemoteSkillCatalog(service as unknown as SkillhubMarketService, input);
beforeEach(() => vi.resetAllMocks());

describe('selected computer uses its full Skill Hub service', () => {
  it('preserves complete metadata and pagination, forwarding public/team filters', async () => {
    const response = {
      success: true,
      items: [
        { name: 'example', authorName: 'Author', downloads: 321, tags: [{ slug: 'research' }] },
      ],
      nextCursor: '3',
    };
    service.listMarket.mockResolvedValue(response);
    await expect(
      read({
        method: 'list',
        scope: 'team',
        q: 'research',
        category: 'knowledge',
        sort: 'downloads',
        cursor: '2',
        limit: 1000,
      }),
    ).resolves.toBe(response);
    expect(service.listMarket).toHaveBeenCalledWith({
      scope: 'team',
      q: 'research',
      category: 'knowledge',
      sort: 'downloads',
      cursor: '2',
      limit: 24,
      mine: false,
      available: false,
    });
    await read({ method: 'list', scope: 'market', mine: true });
    expect(service.listMarket).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'market', mine: true }),
    );
  });
  it('reads categories, full details, the published file tree and content from the same scope', async () => {
    await read({ method: 'categories', scope: 'team' });
    expect(service.listCategories).toHaveBeenCalledWith('team', false);
    await read({ method: 'info', scope: 'market', name: 'example' });
    expect(service.info).toHaveBeenCalledWith('example', 'market');
    await read({ method: 'files', scope: 'team', name: 'example', version: '1.2.3' });
    expect(service.getPublishedFiles).toHaveBeenCalledWith({
      name: 'example',
      version: '1.2.3',
      catalogScope: 'team',
    });
    await read({
      method: 'file',
      scope: 'team',
      name: 'example',
      version: '1.2.3',
      path: 'references/guide.md',
    });
    expect(service.readPublishedFile).toHaveBeenCalledWith({
      name: 'example',
      version: '1.2.3',
      catalogScope: 'team',
      path: 'references/guide.md',
    });
    await read({ method: 'scan-status', scope: 'market', name: 'example', version: '1.2.3' });
    expect(service.getScanStatus).toHaveBeenCalledWith({
      slug: 'example',
      version: '1.2.3',
      catalogScope: 'market',
    });
  });
  it.each([
    { method: 'delete', scope: 'market', name: 'example' },
    { method: 'list', scope: 'private' },
    { method: 'list', scope: 'market', cursor: '../2' },
    { method: 'list', scope: 'market', sort: 'arbitrary' },
    { method: 'info', scope: 'market', name: '../example' },
    ...['../SKILL.md', '/etc/passwd', 'references/../SKILL.md', 'C:\\private', './SKILL.md'].map(
      (path) => ({ method: 'file', scope: 'market', name: 'example', path }),
    ),
  ])('rejects unsupported operations and caller paths: %j', async (input) => {
    await expect(read(input)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(Object.values(service).every((method) => method.mock.calls.length === 0)).toBe(true);
  });
});
