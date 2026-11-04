/** Standard App pages; existing main.js handlers remain the only tool implementation. */
import { mockAppHtml } from './mcp-apps-mock.mjs';
import { RAW_APP_HTML } from './mcp-apps-raw-fixture.mjs';
export async function pluginUiFixture(raw = false, allowed, probes = false) {
  const names = raw ? ['open_metrics', 'refresh_metrics'] : ['draft_form', 'create_application'];
  if (probes) names.push('file_probe');
  const manifest = { schemaVersion: 3, minCindyVersion: '0.1.122-beta', id: raw ? 'ui-planner-raw' : 'ui-planner-sdk',
    name: raw ? '原生协议交互页面' : 'SDK 交互页面', version: '1.0.0', kind: 'chip', entry: 'main.js',
    whenToUse: '演示标准 MCP Apps 交互页面，打开表单或指标页面',
    ...(allowed ? { network: { hosts: [new URL(allowed).hostname] } } : {}),
    tools: names.map(name => ({ name, description: name, parameters: { type: 'object', additionalProperties: true } })),
    mcpApps: { ui: { resources: [{
            uri: "ui://planner",
            file: 'ui/planner.html',
            prefersBorder: true,
            ...(allowed ? { csp: Object.fromEntries(['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].map(key => [key, [allowed]])) } : {})
        }], tools: { [names[0]]: { resourceUri: "ui://planner" }, [names[1]]: { visibility: ['app'] }, ...(probes ? { file_probe: { visibility: ['app'] } } : {}) } } },
  };
  const main = `let count=0;cindy.onHostMessage(message=>{if(message.type!=='tool-call')return;
    const args=message.args||{};let result;
    if(message.tool==='file_probe'){
      cindy.send({type:'tool-progress',callId:message.callId,progress:1,total:2,message:'Reading'});
      setTimeout(()=>cindy.send({type:'tool-result',callId:message.callId,ok:true,result:{content:[{type:'resource_link',name:'fixture.txt',uri:'library:fixture.txt',mimeType:'text/plain'},{type:'resource_link',name:'picked.png',uri:'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',mimeType:'image/png'}]}}),350);return;
    }
    if(message.tool==='draft_form')result={content:[{type:'text',text:'Draft: '+args.title}],structuredContent:args,_meta:{viewOnly:'metadata-for-the-view'}};
    else if(message.tool==='create_application')result={content:[{type:'text',text:'已创建模拟申请 '+(++count)}],structuredContent:args};
    else {if(message.tool==='refresh_metrics')count++;result={content:[{type:'text',text:'Metrics'}],structuredContent:{metrics:{threshold:args.threshold||75,refreshes:count}},_meta:{viewOnly:'independent-view-metadata'}};}
    cindy.send({type:'tool-result',callId:message.callId,ok:true,result});});`;
  return { manifest, main, html: raw ? RAW_APP_HTML : await mockAppHtml() };
}
