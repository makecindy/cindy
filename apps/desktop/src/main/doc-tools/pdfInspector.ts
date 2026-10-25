import {inspectPdfPagesInChild} from '../reviewer/reviewPdfProcess.js';
import {createPdfInspector} from '@cindy/app-runtime/pdfInspector';
export const {inspectPdf}=createPdfInspector(inspectPdfPagesInChild);
