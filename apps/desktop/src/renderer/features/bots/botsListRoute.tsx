import type { RouteObject } from 'react-router-dom';

/**
 * BotsFeatureLayout already supplies the partner list in its sidebar. Leave the
 * content pane unselected on startup: /bots selects Cindy and /bots/roster opens
 * the creation dialog. Neither belongs to passive navigation restoration.
 */
export const botsListRoute: RouteObject = {
  path: 'list',
  element: <main className="h-full" />,
};
