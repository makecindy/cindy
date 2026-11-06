import { parse, type DefaultTreeAdapterTypes } from 'parse5';

const moduleName = '@modelcontextprotocol/ext-apps';
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
function environmentPlan(html: string) {
  // A byte-order mark is an encoding marker, not text before the doctype.
  const offset = html.startsWith('\ufeff') ? 1 : 0;
  const document = parse(html.slice(offset), { sourceCodeLocationInfo: true });
  let insertion = offset;
  let authoredSdk = false;
  let authoredMap: { start: number; end: number; value: Record<string, unknown> } | undefined;
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if (node.nodeName === '#documentType') insertion = (node.sourceCodeLocation?.endOffset ?? 0) + offset;
    if ('tagName' in node && node.namespaceURI === htmlNamespace) {
      if (node.tagName === 'head' && node.sourceCodeLocation?.startTag)
        insertion = node.sourceCodeLocation.startTag.endOffset + offset;
      if (node.tagName === 'script') {
        const type = (node.attrs.find(attr => attr.name === 'type')?.value ?? '')
          .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
        const text = node.childNodes.map(child => 'value' in child ? child.value : '').join('');
        if (type === 'importmap') {
          try {
            const map = JSON.parse(text);
            authoredSdk ||= Object.entries(map?.imports ?? {}).some(([name, address]) =>
              (name === moduleName || (name.endsWith('/') && moduleName.startsWith(name))) &&
              (address === null || (typeof address === 'string' &&
                (name === moduleName || address.endsWith('/')))));
            const location = node.sourceCodeLocation;
            if (!authoredMap && map && typeof map === 'object' && !Array.isArray(map) &&
                (map.imports === undefined || (map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports))) &&
                location?.startTag && location.endTag) {
              authoredMap = { start: location.startTag.endOffset + offset, end: location.endTag.startOffset + offset, value: map };
            }
          } catch { /* Invalid authored maps remain the browser's responsibility. */ }
        }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(document);
  return { insertion, authoredMap, authoredSdk };
}

// The default form action is always disabled by CSP. Cancel it before Chromium
// navigates to a CSP error document; page handlers still run before this fallback.
const runtime = `<script data-cindy-runtime>
(()=>{
 // method=dialog only closes its dialog: no navigation, so no CSP error document.
 // The prototype getter: a control named "method" shadows form.method.
 const method=Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,'method').get;
 const dialog=event=>event.target instanceof HTMLFormElement&&(event.submitter?.hasAttribute('formmethod')?event.submitter.formMethod:Reflect.apply(method,event.target,[]))==='dialog';
 const prevent=event=>{if(!event.defaultPrevented&&!dialog(event))event.preventDefault();};
 // Arm during window capture: the fallback is then appended after the page's own
 // window submit listeners, yet still runs before the browser's default action.
 const arm=()=>{window.removeEventListener('submit',prevent);window.addEventListener('submit',prevent,{once:true});};
 const install=()=>window.addEventListener('submit',arm,true);
 const open=Document.prototype.open;
 Document.prototype.open=function(...args){
  const result=Reflect.apply(open,this,args);
  if(this===document&&args.length<3)install();
  return result;
 };
 for(const method of ['write','writeln']){
  const write=Document.prototype[method];
  Document.prototype[method]=function(...args){
   const result=Reflect.apply(write,this,args);
   if(this===document)install();
   return result;
  };
 }
 // Direct submit() skips the event; requestSubmit() still runs page handlers.
 const submit=HTMLFormElement.prototype.submit;
 HTMLFormElement.prototype.submit=function(){if(Reflect.apply(method,this,[])==='dialog')Reflect.apply(submit,this,[]);};
 install();
})();
</script>`;

/** Prepare the App environment outside the chat contract's startup dependency graph. */
export function withHostAppSdk(html: string, sdkUrl: string): string {
  if (!new URL(sdkUrl).hostname) throw new Error('MCP_APP_SDK_URL_REQUIRED');
  const { insertion, authoredMap, authoredSdk } = environmentPlan(html);
  let prefix = runtime;
  if (!authoredSdk) {
    if (authoredMap) {
      const value = { ...authoredMap.value, imports: {
        ...(authoredMap.value.imports as Record<string, unknown> | undefined), [moduleName]: sdkUrl,
      } };
      html = html.slice(0, authoredMap.start) + JSON.stringify(value).replace(/</g, '\\u003c') + html.slice(authoredMap.end);
    } else {
      prefix += '<script type="importmap">' + JSON.stringify({ imports: { [moduleName]: sdkUrl } }) + '</script>';
    }
  }
  return html.slice(0, insertion) + prefix + html.slice(insertion);
}
