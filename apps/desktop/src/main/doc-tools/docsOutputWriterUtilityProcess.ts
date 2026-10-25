export * from '@cindy/app-runtime/docsOutputWriterUtilityProcess';
import {attachDocsOutputWriter} from '@cindy/app-runtime/docsOutputWriterUtilityProcess';
const port=(process as unknown as {parentPort?:Parameters<typeof attachDocsOutputWriter>[0]}).parentPort;
if(port)attachDocsOutputWriter(port);
