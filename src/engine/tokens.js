/**
 * Token grammar and batch namespacing.
 *
 * A token looks like [PP_7K3M9Q2A_S07]:
 *   PP        fixed prefix
 *   7K3M9Q2A  batch namespace, 8 base32 chars (40 bits) from crypto.getRandomValues
 *   S07       entity type code + number
 *
 * The namespace is not a secret. Its only job is to make it obvious when feedback
 * belongs to a different batch than the map being used to restore it.
 */

// Crockford-style alphabet: no I, L, O or U, so nothing reads as a digit or a rude word.
const BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
export const BATCH_ID_LENGTH = 8;

export const TYPE_CODES = {
  PERSON: 'S',
  DOCUMENT: 'D',
  EMAIL: 'EM',
  PHONE: 'PH',
  SSN: 'SSN',
  STUDENT_ID: 'ID',
  CREDIT_CARD: 'CC',
  IP_ADDRESS: 'IP',
  URL: 'URL',
  ADDRESS: 'AD',
  DATE_OF_BIRTH: 'DOB',
  MANUAL: 'RX',
};

/** Matches a well-formed token of any batch. Capture groups: batch, type, number. */
export const TOKEN_PATTERN = /\[PP_([A-Z0-9]{8})_([A-Z]{1,3})(\d{2,4})\]/g;

/**
 * Deliberately loose: catches things that were *probably* one of our tokens before an
 * LLM reformatted them — lowercase, spaced out, or stripped of brackets. Used only to
 * warn, never to substitute.
 */
export const TOKEN_LIKE_PATTERN = /\[?\s*PP\s*[_-]\s*([A-Za-z0-9]{4,12})\s*[_-]\s*([A-Za-z]{1,3})\s*(\d{1,4})\s*\]?/g;

function randomBytes(n) {
  const out = new Uint8Array(n);
  // Present in browsers, Web Workers and Node 19+.
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Cryptographically random 8-character batch namespace. */
export function generateBatchId() {
  const bytes = randomBytes(BATCH_ID_LENGTH);
  let id = '';
  for (const b of bytes) id += BASE32[b % BASE32.length];
  return id;
}

export function isValidBatchId(id) {
  return typeof id === 'string' && new RegExp(`^[A-Z0-9]{${BATCH_ID_LENGTH}}$`).test(id);
}

/** Build a token string. `n` is 1-based and rendered with at least two digits. */
export function makeToken(batchId, typeCode, n) {
  if (!isValidBatchId(batchId)) throw new Error('Invalid batch id');
  if (!/^[A-Z]{1,3}$/.test(typeCode)) throw new Error('Invalid type code');
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('Invalid token number');
  return `[PP_${batchId}_${typeCode}${String(n).padStart(2, '0')}]`;
}

export function parseToken(token) {
  const m = new RegExp(`^${TOKEN_PATTERN.source}$`).exec(token);
  if (!m) return null;
  return { batchId: m[1], typeCode: m[2], number: Number(m[3]) };
}

/**
 * Fisher-Yates over 1..count using rejection-sampled CSPRNG values.
 *
 * Token numbers must not follow roster order: [PP_..._S01] on the alphabetically first
 * student would leak roster position, which is itself identifying in a small class.
 */
export function shuffledNumbers(count) {
  const nums = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = randomIntBelow(i + 1);
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

/** Uniform random integer in [0, max) with no modulo bias. */
function randomIntBelow(max) {
  if (max <= 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v;
  do {
    globalThis.crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

/** Every well-formed token present in `text`, with offsets. */
export function findTokens(text) {
  const found = [];
  const re = new RegExp(TOKEN_PATTERN.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({
      token: m[0],
      batchId: m[1],
      typeCode: m[2],
      number: Number(m[3]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

/**
 * True if `text` already contains anything resembling a token in the given batch.
 * A student who writes about placeholder syntax must not have their own text
 * rewritten during restoration, so on a hit the caller regenerates the namespace.
 */
export function hasTokenCollision(text, batchId) {
  return findTokens(text).some((t) => t.batchId === batchId);
}

/** Token-shaped text of any batch — reported to the user during protection. */
export function findTokenLikeText(text) {
  const found = [];
  // Case-insensitive: an LLM that lowercases its output still produced our token.
  const re = new RegExp(TOKEN_LIKE_PATTERN.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return found;
}
