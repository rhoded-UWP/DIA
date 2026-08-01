/**
 * Overlap resolution.
 *
 * Recognizers fire independently, so one span of text can produce several detections:
 * a full roster name contains a unique surname, an email contains something that looks
 * like a URL. Exactly one detection may survive per span, or replacement would corrupt
 * the text.
 *
 * Precedence: higher priority first (a full name beats a bare surname), then the longer
 * match, then the earlier one so the result is deterministic.
 */

export function resolveOverlaps(detections) {
  const sorted = [...detections].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenB !== lenA) return lenB - lenA;
    return a.start - b.start;
  });

  /** @type {{start:number,end:number}[]} kept spans, ordered by start */
  const taken = [];
  const kept = [];

  for (const d of sorted) {
    if (!overlapsAny(taken, d)) {
      insertSorted(taken, d);
      kept.push(d);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

function overlapsAny(taken, d) {
  let lo = 0;
  let hi = taken.length - 1;
  // Find the last span starting at or before d.start; only it and its successor can touch d.
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (taken[mid].start <= d.start) lo = mid + 1;
    else hi = mid - 1;
  }
  const before = taken[lo - 1];
  const after = taken[lo];
  if (before && before.end > d.start) return true;
  if (after && d.end > after.start) return true;
  return false;
}

function insertSorted(taken, d) {
  let lo = 0;
  let hi = taken.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (taken[mid].start < d.start) lo = mid + 1;
    else hi = mid;
  }
  taken.splice(lo, 0, { start: d.start, end: d.end });
}
