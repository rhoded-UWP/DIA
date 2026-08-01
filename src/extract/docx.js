/**
 * DOCX extraction. Runs inside the engine worker.
 *
 * Two deliberate constraints:
 *
 *   Plain text only. mammoth.extractRawText() is used rather than its HTML conversion,
 *   because mammoth does not sanitize its input and its own documentation warns that a
 *   document may carry dangerous links or external references. Nothing produced here is
 *   ever inserted as markup.
 *
 *   Body text is not the whole document. Comments, headers, footers, footnotes and
 *   tracked deletions all routinely contain names, and raw-text extraction does not
 *   return them. When the package contains any of those, the instructor is told so they
 *   can check the original rather than trusting a clean-looking result.
 */

import { LIMITS, formatBytes } from '../engine/limits.js';

const mammoth = () => globalThis.mammoth;
const JSZip = () => globalThis.JSZip;

/**
 * @returns {Promise<{text:string, metadataNames:string[], warnings:string[], blocking:string[]}>}
 */
export async function extractDocx(arrayBuffer) {
  const warnings = [];
  const blocking = [];
  const metadataNames = [];

  let zip;
  try {
    zip = await JSZip().loadAsync(arrayBuffer);
  } catch {
    return {
      text: '', metadataNames, warnings,
      blocking: ['This file could not be opened as a Word document. It may be corrupted, or it may not be a .docx file.'],
    };
  }

  const zipProblem = checkZipShape(zip);
  if (zipProblem) return { text: '', metadataNames, warnings, blocking: [zipProblem] };

  const names = Object.keys(zip.files);
  const has = (re) => names.some((n) => re.test(n));

  if (has(/^word\/comments\.xml$/)) {
    warnings.push('This document contains comments. Plain-text extraction does not include them, so any names inside comments are still in the original file.');
  }
  if (has(/^word\/(header|footer)\d*\.xml$/)) {
    warnings.push('This document has headers or footers. They are not included in the extracted text — check them for names.');
  }
  if (has(/^word\/(footnotes|endnotes)\.xml$/)) {
    const hasRealNotes = await notesHaveContent(zip, names);
    if (hasRealNotes) {
      warnings.push('This document has footnotes or endnotes, which are not included in the extracted text.');
    }
  }

  const documentXml = await readText(zip, 'word/document.xml');
  if (documentXml) {
    if (/<w:(ins|del)\b/.test(documentXml)) {
      warnings.push('This document contains tracked changes. Deleted text is not extracted but is still present in the original file.');
    }
    if (/<w:txbxContent\b/.test(documentXml)) {
      warnings.push('This document contains text boxes, which may not be extracted in reading order.');
    }
  }
  if (has(/^word\/embeddings\//)) {
    warnings.push('This document has embedded objects (such as a spreadsheet). Their contents are not extracted.');
  }

  // Author metadata is a reliable source of the student's name and is scrubbed by
  // virtue of never being copied into the output — but it is a useful detection hint.
  const core = await readText(zip, 'docProps/core.xml');
  if (core) {
    for (const tag of ['dc:creator', 'cp:lastModifiedBy']) {
      const m = new RegExp(`<${tag}>([^<]{1,200})</${tag}>`).exec(core);
      if (m && m[1].trim()) metadataNames.push(m[1].trim());
    }
  }
  const app = await readText(zip, 'docProps/app.xml');
  if (app) {
    const m = /<Company>([^<]{1,200})<\/Company>/.exec(app);
    if (m && m[1].trim()) metadataNames.push(m[1].trim());
  }

  let text = '';
  try {
    const result = await mammoth().extractRawText({ arrayBuffer });
    text = result.value ?? '';
    for (const message of result.messages ?? []) {
      if (message.type === 'error') warnings.push(`Word conversion: ${message.message}`);
    }
  } catch (err) {
    return {
      text: '', metadataNames, warnings,
      blocking: [`This document could not be read (${err?.message ?? 'unknown error'}). Open it in Word, re-save it, and try again.`],
    };
  }

  if (text.trim().length === 0) {
    // An empty result is a failed extraction, not a clean document.
    blocking.push('No text could be extracted from this document. If it contains only images or drawings, the text cannot be checked here.');
  }
  if (text.length > LIMITS.maxExtractedChars) {
    blocking.push(`This document produced ${text.length.toLocaleString()} characters, past the ${LIMITS.maxExtractedChars.toLocaleString()} limit.`);
  }

  return { text, metadataNames, warnings, blocking };
}

/** Zip-bomb and shape guards, applied before anything is decompressed. */
function checkZipShape(zip) {
  const files = Object.values(zip.files);
  if (files.length > LIMITS.maxZipEntries) {
    return `This document contains ${files.length} internal parts, past the ${LIMITS.maxZipEntries} limit.`;
  }
  let uncompressed = 0;
  let compressed = 0;
  for (const f of files) {
    const u = f._data?.uncompressedSize ?? 0;
    const c = f._data?.compressedSize ?? 0;
    uncompressed += u;
    compressed += c;
    if (c > 0 && u / c > LIMITS.maxZipCompressionRatio) {
      return 'This document expands far more than its file size suggests and was not opened.';
    }
  }
  if (uncompressed > LIMITS.maxZipUncompressedBytes) {
    return `This document expands to ${formatBytes(uncompressed)}, past the ${formatBytes(LIMITS.maxZipUncompressedBytes)} limit.`;
  }
  return null;
}

async function readText(zip, path) {
  const entry = zip.file(path);
  if (!entry) return null;
  try {
    return await entry.async('string');
  } catch {
    return null;
  }
}

/** Word writes a footnotes part even with no footnotes; it holds only separator marks. */
async function notesHaveContent(zip, names) {
  for (const path of names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))) {
    const xml = await readText(zip, path);
    if (xml && /<w:footnote\b(?![^>]*w:type=)|<w:endnote\b(?![^>]*w:type=)/.test(xml)) return true;
  }
  return false;
}
