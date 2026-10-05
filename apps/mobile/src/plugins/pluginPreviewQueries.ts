const prefix = "__cindy_plugin_query/";
/** Existing native snapshots strip query strings. Encode GET query targets as opaque resource paths. */
export function pluginPreviewQueryTarget(
  path: string,
  origin: string,
): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const hex = path.slice(prefix.length);
  if (!/^(?:[a-f0-9]{2}){1,4096}$/.test(hex))
    throw new Error("INVALID_PREVIEW_QUERY");
  const target = new URL(
    Array.from({ length: hex.length / 2 }, (_, index) =>
      String.fromCharCode(parseInt(hex.slice(index * 2, index * 2 + 2), 16)),
    ).join(""),
    origin,
  );
  if (
    target.origin !== origin ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new Error("INVALID_PREVIEW_QUERY");
  return target.href;
}
export const PLUGIN_PREVIEW_QUERY_SCRIPT = `<script>(()=>{
  const map=(raw)=>{const u=new URL(raw,location.href);if(u.origin!==location.origin||!u.search)return raw;
    const value=u.pathname+u.search;if(value.length>4096)throw new Error('PREVIEW_QUERY_TOO_LARGE');
    return location.origin+'/__cindy_plugin_query/'+Array.from(value,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');};
  const fetch=window.fetch.bind(window);window.fetch=(input,init)=>fetch(input instanceof Request?new Request(map(input.url),input):map(String(input)),init);
  const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(String(url)),...rest);};
})();</script>`;
