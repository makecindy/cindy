import { Navigate, useLocation, useParams } from 'react-router-dom';

/**
 * Preserve existing bookmarks, command-palette links, and older market URLs.
 *
 * Kept apart from SkillhubDetailRoute so the router can register these redirects
 * without statically loading the detail page (and its CodeMirror editor).
 */
export function LegacySkillDetailRedirect({ market = false }: { market?: boolean }) {
  const params = useParams();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('view', market ? 'market' : 'local');
  if (market) {
    search.set('remote', params.name ?? '');
    if (!search.has('catalog')) search.set('catalog', location.pathname.startsWith('/skillhub/market/manage/') ? 'native' : 'market');
    if (!search.has('returnTo')) search.set('returnTo', '/skillhub/market');
  } else {
    if (params.kind) search.set('kind', params.kind);
    if (params.name) search.set('name', params.name);
    if (params.projectHash) search.set('project', params.projectHash);
    if (!search.has('scope') && params.kind) search.set('scope', params.projectHash ? 'project' : 'global');
  }
  return <Navigate to={`/skillhub/detail?${search}`} replace state={location.state} />;
}
