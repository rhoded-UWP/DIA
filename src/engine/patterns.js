/**
 * Pattern recognizers for structured PII.
 *
 * Patterns follow the recognizer set used by Microsoft Presidio and DataFog, rewritten
 * for JavaScript. Every pattern here is written to avoid catastrophic backtracking:
 * no quantifier nested inside another quantifier, and every repetition is either bounded
 * or over a character class that cannot also start the next element. Untrusted student
 * text runs through all of them, and the engine worker's deadline is the backstop rather
 * than the defence.
 *
 * Where a pattern alone is too loose to trust (credit cards, IP addresses, dates of
 * birth), a validator or a context requirement decides whether the hit survives.
 */

import { BOUNDARY_BEFORE, BOUNDARY_AFTER } from './normalize.js';

export const PRIORITY = {
  SSN: 95,
  CREDIT_CARD: 92,
  EMAIL: 90,
  STUDENT_ID: 88,
  PHONE: 85,
  IP_ADDRESS: 70,
  URL: 65,
  ADDRESS: 62,
  DATE_OF_BIRTH: 55,
};

function push(out, m, type, extra = {}) {
  out.push({
    start: m.index,
    end: m.index + m[0].length,
    matched: m[0],
    type,
    kind: `pattern-${type.toLowerCase()}`,
    priority: PRIORITY[type],
    needsDecision: false,
    ...extra,
  });
}

function scan(text, regex, fn) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    fn(m);
  }
}

/* ---------------------------------------------------------------- email --- */

// The domain is matched loosely and validated afterwards; a regex that tries to enforce
// dot structure inline needs an ambiguous `(?:\.x+)*\.x+` tail, which backtracks badly.
const EMAIL_RE = /[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,253}[A-Za-z0-9])?/gu;

function validEmailTail(value) {
  const at = value.lastIndexOf('@');
  const domain = value.slice(at + 1);
  return /^[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/.test(domain) && /\.[A-Za-z]{2,24}$/.test(domain);
}

export function findEmails(text, out = []) {
  scan(text, EMAIL_RE, (m) => {
    // Trim trailing dots/hyphens the loose domain class may have swallowed.
    let value = m[0].replace(/[.\-]+$/, '');
    if (!validEmailTail(value)) return;
    out.push({
      start: m.index, end: m.index + value.length, matched: value,
      type: 'EMAIL', kind: 'pattern-email', priority: PRIORITY.EMAIL, needsDecision: false,
    });
  });
  return out;
}

/* ---------------------------------------------------------------- phone --- */

const PHONE_RE = new RegExp(
  `${BOUNDARY_BEFORE}(?:\\+?1[\\s.\\-]?)?(?:\\(\\d{3}\\)|\\d{3})[\\s.\\-]?\\d{3}[\\s.\\-]?\\d{4}${BOUNDARY_AFTER}`,
  'gu',
);

export function findPhones(text, out = []) {
  scan(text, PHONE_RE, (m) => push(out, m, 'PHONE'));
  return out;
}

/* ------------------------------------------------------------------ ssn --- */

// Only the punctuated forms. A bare nine-digit run is far more often a student ID here,
// and the student-ID recognizer handles those with a format the instructor supplies.
const SSN_RE = new RegExp(`${BOUNDARY_BEFORE}\\d{3}[\\s\\-]\\d{2}[\\s\\-]\\d{4}${BOUNDARY_AFTER}`, 'gu');

export function findSsns(text, out = []) {
  scan(text, SSN_RE, (m) => push(out, m, 'SSN'));
  return out;
}

/* ---------------------------------------------------------- credit card --- */

const CARD_RE = new RegExp(
  `${BOUNDARY_BEFORE}(?:\\d{4}[ \\-]?\\d{4}[ \\-]?\\d{4}[ \\-]?\\d{1,4}|\\d{4}[ \\-]?\\d{6}[ \\-]?\\d{5})${BOUNDARY_AFTER}`,
  'gu',
);

export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

export function findCreditCards(text, out = []) {
  scan(text, CARD_RE, (m) => {
    const digits = m[0].replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) return;
    if (!luhnValid(digits)) return;
    push(out, m, 'CREDIT_CARD');
  });
  return out;
}

/* ------------------------------------------------------------------- ip --- */

const IP_RE = new RegExp(`${BOUNDARY_BEFORE}\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}${BOUNDARY_AFTER}`, 'gu');

export function findIpAddresses(text, out = []) {
  scan(text, IP_RE, (m) => {
    const octets = m[0].split('.');
    if (!octets.every((o) => o.length <= 3 && Number(o) <= 255)) return;
    push(out, m, 'IP_ADDRESS');
  });
  return out;
}

/* ------------------------------------------------------------------ url --- */

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`)\]}]{1,2000}/gu;

export function findUrls(text, out = []) {
  scan(text, URL_RE, (m) => {
    // Sentence punctuation is not part of the URL.
    const value = m[0].replace(/[.,;:!?]+$/, '');
    out.push({
      start: m.index, end: m.index + value.length, matched: value,
      type: 'URL', kind: 'pattern-url', priority: PRIORITY.URL, needsDecision: false,
    });
  });
  return out;
}

/* -------------------------------------------------------------- address --- */

const STREET_TYPES = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Highway|Hwy';

// The match deliberately stops before any trailing period. Allowing one so that "St."
// could be matched whole meant that in "…at 12 Oak St." the sentence's full stop was
// consumed too, and the redacted line came back missing its punctuation. The dot is
// inside redacted content either way, so leaving it in the sentence loses nothing.
const ADDRESS_RE = new RegExp(
  `${BOUNDARY_BEFORE}\\d{1,6}\\s+(?:[\\p{Lu}][\\p{L}\\p{M}'\\-]{0,20}\\s+){0,4}(?:${STREET_TYPES})${BOUNDARY_AFTER}`,
  'gu',
);

export function findAddresses(text, out = []) {
  scan(text, ADDRESS_RE, (m) => push(out, m, 'ADDRESS'));
  return out;
}

/* -------------------------------------------------------- date of birth --- */

const DATE_RE = new RegExp(
  `${BOUNDARY_BEFORE}(?:\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}` +
  `|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4})${BOUNDARY_AFTER}`,
  'giu',
);
const BIRTH_CONTEXT = /(date\s+of\s+birth|birth\s*date|birthday|born\s+on|born|d\.o\.b\.?|dob)\s*[:\-]?\s*$/i;

/** Dates only count as PII when a birth-related phrase immediately precedes them. */
export function findDatesOfBirth(text, out = []) {
  scan(text, DATE_RE, (m) => {
    const window = text.slice(Math.max(0, m.index - 40), m.index);
    if (!BIRTH_CONTEXT.test(window)) return;
    push(out, m, 'DATE_OF_BIRTH');
  });
  return out;
}

/* ----------------------------------------------------------- student id --- */

/**
 * Compile an instructor-supplied ID shape: '#' is a digit, 'A' is a letter, everything
 * else is literal. "########" or "W#######" are typical. Safe by construction — the
 * instructor never writes a quantifier.
 */
export function compileIdFormat(format) {
  const trimmed = String(format).trim();
  if (!trimmed) return null;
  if (trimmed.length > 40) throw new Error('ID format is too long.');
  let source = '';
  for (const ch of trimmed) {
    if (ch === '#') source += '\\d';
    else if (ch === 'A' || ch === 'a') source += '[A-Za-z]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${BOUNDARY_BEFORE}${source}${BOUNDARY_AFTER}`, 'gu');
}

/**
 * Heuristic screen for a raw regex typed by the instructor. It rejects the shapes that
 * cause exponential backtracking — a quantified group whose body is itself quantified.
 * Not a proof of safety, which is why the worker deadline still applies.
 */
export function looksUnsafeRegex(source) {
  if (source.length > 200) return true;
  if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(source)) return true;
  if (/\([^)]*\{\d+,\}?[^)]*\)\s*[+*{]/.test(source)) return true;
  if (/(\[[^\]]*\][+*]){3,}/.test(source)) return true;
  return false;
}

export function compileIdRegex(raw) {
  const source = String(raw).trim();
  if (!source) return null;
  if (looksUnsafeRegex(source)) {
    throw new Error('That pattern could hang the browser (nested repetition). Use the simple ID format instead.');
  }
  return new RegExp(`${BOUNDARY_BEFORE}(?:${source})${BOUNDARY_AFTER}`, 'gu');
}

export function findStudentIds(text, idRegex, out = []) {
  if (!idRegex) return out;
  scan(text, idRegex, (m) => push(out, m, 'STUDENT_ID'));
  return out;
}

/* ---------------------------------------------------------------- all in --- */

export const RECOGNIZERS = [
  { id: 'EMAIL', label: 'Email addresses', run: findEmails, default: true },
  { id: 'PHONE', label: 'Phone numbers', run: findPhones, default: true },
  { id: 'SSN', label: 'Social security numbers', run: findSsns, default: true },
  { id: 'CREDIT_CARD', label: 'Credit card numbers', run: findCreditCards, default: true },
  { id: 'IP_ADDRESS', label: 'IP addresses', run: findIpAddresses, default: true },
  { id: 'URL', label: 'Web addresses', run: findUrls, default: false },
  { id: 'ADDRESS', label: 'Street addresses', run: findAddresses, default: true },
  { id: 'DATE_OF_BIRTH', label: 'Dates of birth', run: findDatesOfBirth, default: true },
];

/**
 * @param {string} text
 * @param {{enabled?: string[], idRegex?: RegExp|null}} options
 */
export function findPatterns(text, options = {}) {
  const enabled = new Set(options.enabled ?? RECOGNIZERS.filter((r) => r.default).map((r) => r.id));
  const out = [];
  for (const r of RECOGNIZERS) {
    if (enabled.has(r.id)) r.run(text, out);
  }
  findStudentIds(text, options.idRegex ?? null, out);
  return out;
}
