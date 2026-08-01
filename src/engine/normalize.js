/**
 * Text normalization.
 *
 * Two separate jobs, and the difference matters:
 *
 * 1. normalizeDocumentText() runs once at extraction. It may change string length
 *    (NFC composes "e" + combining acute into "é"), so it must happen BEFORE any
 *    offset is recorded. Everything downstream treats its output as the document.
 *
 * 2. foldForMatching() builds a search view of already-normalized text. Every
 *    substitution is exactly one character for one character, so offsets in the folded
 *    string are valid offsets in the real string. That is what lets us match "O’Connor"
 *    against a roster spelling of "O'Connor" and still slice the original text.
 */

/** Length-preserving character folds: quote, dash and space look-alikes. */
const FOLD_MAP = new Map([
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['′', "'"], ['´', "'"], ['`', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['″', '"'],
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'],
  ['—', '-'], ['―', '-'], ['−', '-'],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '],
]);

export function normalizeDocumentText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    // Zero-width characters can split a name invisibly ("Ja​ne"), defeating
    // matching while still reading as the name on screen. Removing them changes
    // length, which is why this belongs here and not in foldForMatching.
    .replace(/[​‌‍﻿]/g, '')
    .normalize('NFC');
}

export function foldForMatching(text) {
  let out = '';
  for (const ch of text) {
    out += FOLD_MAP.get(ch) ?? ch;
  }
  return out;
}

/** Case-and-whitespace-insensitive key for comparing values. */
export function canonicalKey(value) {
  return foldForMatching(String(value).normalize('NFC')).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Unicode-aware word boundaries. JavaScript's \b is ASCII-only: it would treat the "é"
 * in "José" as a boundary and happily match "Jos" inside it.
 */
export const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
export const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
