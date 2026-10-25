import {attachDocsOutputWriter} from '@cindy/app-runtime/docsOutputWriterUtilityProcess';
if(!process.send)throw new Error('DOCS_WORKER_IPC_REQUIRED');
process.once('disconnect',()=>process.exit(0));
attachDocsOutputWriter({postMessage:value=>{process.send?.(value);},on:(_event,listener)=>{process.on('message',data=>listener({data}));}});
