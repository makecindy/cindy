export * from '@cindy/app-runtime/reviewPdfUtilityProcess';
import {attachReviewPdfUtility} from '@cindy/app-runtime/reviewPdfUtilityProcess';
const port=(process as unknown as {parentPort?:Parameters<typeof attachReviewPdfUtility>[0]}).parentPort;
if(port)attachReviewPdfUtility(port);
