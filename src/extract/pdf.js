/**
 * PDF extraction. Runs on the main thread, where pdf.js delegates parsing to its own
 * worker.
 *
 * Version 1 supports only PDFs that carry a real text layer. pdf.js does not perform OCR,
 * so a scanned paper yields an empty string — and an empty string looks exactly like a
 * document with no PII in it. That failure mode is the dangerous one, so extraction
 * problems BLOCK the export instead of producing a warning next to a clean-looking
 * result.
 */

import { LIMITS } from '../engine/limits.js';

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../vendor/pdf.min.mjs').then((lib) => {
      // Same-origin worker file, never a CDN: the CSP forbids anything else, and a
      // dynamically fetched worker would undercut the point of vendoring.
      lib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * @returns {Promise<{text:string, metadataNames:string[], warnings:string[], blocking:string[]}>}
 */
export async function extractPdf(arrayBuffer) {
  const warnings = [];
  const blocking = [];
  const metadataNames = [];
  const pdfjs = await loadPdfjs();

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      // Nothing in a PDF gets to reach the network or run.
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'PasswordException') {
      return {
        text: '', metadataNames, warnings,
        blocking: ['This PDF is password-protected. Remove the password and try again — its text cannot be checked while it is locked.'],
      };
    }
    return {
      text: '', metadataNames, warnings,
      blocking: [`This PDF could not be opened (${err?.message ?? 'unknown error'}). It may be damaged.`],
    };
  }

  try {
    if (doc.numPages > LIMITS.maxPdfPages) {
      return { text: '', metadataNames, warnings, blocking: [`This PDF has ${doc.numPages} pages, past the ${LIMITS.maxPdfPages}-page limit.`] };
    }

    await collectMetadata(doc, metadataNames, warnings);

    const pages = [];
    const emptyPages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pageText = joinTextItems(content.items);
      pages.push(pageText);
      if (pageText.trim().length === 0) emptyPages.push(n);
      page.cleanup();
    }

    const text = pages.join('\n\n');
    const totalChars = text.replace(/\s/g, '').length;

    if (totalChars === 0) {
      blocking.push('No text could be read from this PDF. It is most likely a scan or an export of images. Convert it to a searchable PDF, or review it by hand.');
    } else if (emptyPages.length > 0) {
      // A partially-image PDF is the trap: the pages that did extract look clean, and
      // the ones that did not are invisible.
      blocking.push(`${emptyPages.length} of ${doc.numPages} pages in this PDF contain no readable text (page${emptyPages.length === 1 ? '' : 's'} ${emptyPages.slice(0, 8).join(', ')}${emptyPages.length > 8 ? '…' : ''}). Those pages cannot be checked for personal information.`);
    } else if (totalChars / doc.numPages < LIMITS.minCharsPerPdfPage) {
      blocking.push(`This PDF yielded only ${totalChars} characters across ${doc.numPages} pages, which usually means the pages are images. It cannot be checked reliably.`);
    }

    if (text.length > LIMITS.maxExtractedChars) {
      blocking.push(`This PDF produced ${text.length.toLocaleString()} characters, past the ${LIMITS.maxExtractedChars.toLocaleString()} limit.`);
    }

    return { text, metadataNames, warnings, blocking };
  } finally {
    await doc.destroy();
  }
}

/**
 * Metadata, plus the parts of a PDF that carry content or behaviour this tool does not
 * process. They are reported and excluded rather than silently dropped.
 */
async function collectMetadata(doc, metadataNames, warnings) {
  try {
    const { info } = await doc.getMetadata();
    for (const field of ['Author', 'Creator', 'Title', 'Subject', 'Keywords']) {
      const value = info?.[field];
      if (typeof value === 'string' && value.trim()) metadataNames.push(value.trim());
    }
  } catch { /* metadata is a bonus, not a requirement */ }

  try {
    const attachments = await doc.getAttachments();
    if (attachments && Object.keys(attachments).length > 0) {
      warnings.push('This PDF has file attachments. They are ignored here and are not included in the protected output, but they are still in the original file.');
    }
  } catch { /* ignore */ }

  try {
    const fields = await doc.getFieldObjects();
    if (fields && Object.keys(fields).length > 0) {
      const isSignature = Object.values(fields).flat().some((f) => f?.type === 'signature');
      warnings.push(isSignature
        ? 'This PDF contains form fields including a signature field. Field contents are not extracted.'
        : 'This PDF contains form fields. Their contents are not extracted and may still hold personal information.');
    }
  } catch { /* ignore */ }

  try {
    const actions = await doc.getJSActions();
    if (actions && Object.keys(actions).length > 0) {
      warnings.push('This PDF contains embedded JavaScript. It is never executed here, and is not carried into the protected output.');
    }
  } catch { /* ignore */ }
}

/**
 * Text items back into lines. pdf.js marks line ends with hasEOL; a large horizontal gap
 * between items usually means a column or cell boundary and gets a space.
 *
 * Reading order is whatever order the PDF stores its text in, which for multi-column
 * layouts or tables may not be visual order. The review screen says so — it presents the
 * exported text, not a rendering of the page.
 */
function joinTextItems(items) {
  let out = '';
  let previous = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (previous && !previous.hasEOL) {
      const gap = (item.transform?.[4] ?? 0) - ((previous.transform?.[4] ?? 0) + (previous.width ?? 0));
      if (gap > 1 && !out.endsWith(' ')) out += ' ';
    }
    out += item.str;
    if (item.hasEOL) out += '\n';
    previous = item;
  }
  return out;
}
