import {attachReviewPdfUtility} from '@cindy/app-runtime/reviewPdfUtilityProcess';
if(!process.send)throw new Error('PDF_WORKER_IPC_REQUIRED');
process.once('disconnect',()=>process.exit(0));
attachReviewPdfUtility({postMessage:value=>{process.send?.(value);},on:(_event,listener)=>{process.on('message',data=>listener({data}));}});
