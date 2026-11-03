import type { SkillhubMarketService, ListMarketParams } from './marketService';
import { RemoteResourceRegistryError } from '../device-link/remoteResourceRegistry';

const invalid = (): never => {
  throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid skill catalog request');
};
function text(value: unknown, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
}

/** Fixed read operations reuse the same Hub service as the local Skill pages. */
export async function readRemoteSkillCatalog(
  service: SkillhubMarketService,
  input: Record<string, unknown>,
) {
  const scope = input.scope;
  if (scope !== 'market' && scope !== 'team' && !(input.method === 'list' && scope === 'all'))
    invalid();
  if (input.method === 'list') {
    const sort = input.sort;
    if (
      sort !== undefined &&
      !['trending', 'downloads', 'updated_at', 'created_at'].includes(String(sort))
    )
      invalid();
    if (input.mine !== undefined && typeof input.mine !== 'boolean') invalid();
    const cursor = text(input.cursor, 32, true);
    if (cursor !== undefined && !/^[1-9]\d{0,8}$/.test(cursor)) invalid();
    return service.listMarket({
      scope: scope as ListMarketParams['scope'],
      sort: sort as ListMarketParams['sort'],
      q: text(input.q, 256, true),
      category: text(input.category, 128, true),
      cursor,
      limit: 24,
      mine: input.mine === true,
      available: false,
    });
  }
  if (input.method === 'categories')
    return service.listCategories(scope as 'market' | 'team', false);
  const name = text(input.name, 128)!;
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) invalid();
  const catalogScope = scope as 'market' | 'team';
  if (input.method === 'info') return service.info(name, catalogScope);
  const version = text(input.version, 128, true);
  if (input.method === 'files') return service.getPublishedFiles({ name, version, catalogScope });
  if (input.method === 'file') {
    const filePath = text(input.path, 1024)!;
    if (
      filePath.includes('\\') ||
      filePath.startsWith('/') ||
      filePath.split('/').some((part) => part === '..' || part === '.')
    )
      invalid();
    return service.readPublishedFile({ name, version, path: filePath, catalogScope });
  }
  if (input.method === 'scan-status')
    return service.getScanStatus({ slug: name, version, catalogScope });
  invalid();
}
