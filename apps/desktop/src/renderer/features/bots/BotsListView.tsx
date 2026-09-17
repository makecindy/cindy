/**
 * BotsFeatureLayout already supplies the partner list in its sidebar. Leave the
 * content pane unselected on startup: /bots selects Cindy and /bots/roster opens
 * the creation dialog. Neither belongs to passive navigation restoration.
 */
export function BotsListView() {
  return <main className="h-full" />;
}
