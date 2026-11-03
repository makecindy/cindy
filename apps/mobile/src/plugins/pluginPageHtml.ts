import type { PageConfig } from "./pluginPageBootstrap";
import { PLUGIN_PAGE_BOOTSTRAP } from "./pluginPageBootstrap.generated";

export function pluginPageHtml(config: PageConfig): string {
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><script>document.addEventListener('DOMContentLoaded',()=>(${PLUGIN_PAGE_BOOTSTRAP})(${json}),{once:true})</script></body></html>`;
}
