import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDocumentOptions,inspectPdfInfo} from '../src/document-delivery.mjs';
test('document options forbid outside source paths and unbounded format limits',()=>{
 const d={source:'docs/submission/proposal.md',python:'/runtime/python3',renderer:'/skill/render_docx.py',maxPages:10,maxBytes:20971520};
 assert.deepEqual(validateDocumentOptions(d),d);
 for(const source of ['../secret.md','/etc/passwd','docs/link.docx'])assert.throws(()=>validateDocumentOptions({...d,source}));
 assert.throws(()=>validateDocumentOptions({...d,maxPages:11}));
});
test('PDF inspection rejects excess pages, non-A4 format and missing metadata',()=>{
 assert.equal(inspectPdfInfo('Pages: 8\nPage size: 595.276 x 841.89 pts (A4)\n',10),8);
 assert.throws(()=>inspectPdfInfo('Pages: 11\nPage size: 595.276 x 841.89 pts\n',10),/PAGE_LIMIT/);
 assert.throws(()=>inspectPdfInfo('Pages: 2\nPage size: 612 x 792 pts\n',10),/NOT_A4/);
 assert.throws(()=>inspectPdfInfo('broken',10),/INVALID/);
});
