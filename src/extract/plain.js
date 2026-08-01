/**
 * Markdown and plain text. Nothing to parse, but the encoding still has to be right:
 * a file saved as Windows-1252 decoded as UTF-8 turns "José" into "JosÃ©", and the
 * roster would then fail to match a name that is plainly visible to the reader.
 */

import { LIMITS } from '../engine/limits.js';

export function extractPlainText(arrayBuffer) {
  const warnings = [];
  const blocking = [];
  const bytes = new Uint8Array(arrayBuffer);

  let text = decode(bytes, 'utf-8');

  // U+FFFD means the bytes were not valid UTF-8. Windows-1252 is the usual culprit for
  // files saved out of older editors.
  if (countReplacementChars(text) > 0) {
    const fallback = decode(bytes, 'windows-1252');
    if (countReplacementChars(fallback) === 0) {
      text = fallback;
      warnings.push('This file was not saved as UTF-8. It was read as Windows-1252 instead; check that accented characters look right.');
    } else {
      warnings.push('Some characters in this file could not be decoded and appear as �. Names containing them may not be found.');
    }
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (text.trim().length === 0) {
    blocking.push('This file is empty.');
  }
  if (text.length > LIMITS.maxExtractedChars) {
    blocking.push(`This file has ${text.length.toLocaleString()} characters, past the ${LIMITS.maxExtractedChars.toLocaleString()} limit.`);
  }

  return { text, metadataNames: [], warnings, blocking };
}

function decode(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function countReplacementChars(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) n++;
  }
  return n;
}

export function kindForFilename(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.text')) return 'text';
  if (lower.endsWith('.doc')) return 'legacy-doc';
  return 'unsupported';
}

export const SUPPORTED_EXTENSIONS = '.docx,.pdf,.md,.markdown,.txt,.text';

export function unsupportedMessage(kind, name) {
  if (kind === 'legacy-doc') {
    return `"${name}" is an older .doc file. Open it in Word and save it as .docx, then try again.`;
  }
  return `"${name}" is not a supported file type. Use .docx, .pdf, .md or .txt.`;
}
