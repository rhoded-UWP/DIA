/**
 * Deciding when two detected values are "the same thing" and therefore share one token.
 *
 * Without explicit rules, "JSmith@uni.edu" and "jsmith@uni.edu" become two tokens for
 * one address, and "(608) 555-1212" and "608-555-1212" become two more. The map then
 * misrepresents how many distinct people appear in the batch.
 */

import { canonicalKey } from './normalize.js';

/** Comparison key for a detected value. Same key means same entity. */
export function canonicalValue(type, matched) {
  const raw = String(matched);
  switch (type) {
    case 'EMAIL':
      return raw.toLowerCase();

    case 'PHONE': {
      // Compare by digits; drop a US country code so +1 608 555 1212 == 608-555-1212.
      let d = raw.replace(/\D/g, '');
      if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
      return d;
    }

    case 'SSN':
    case 'CREDIT_CARD':
      return raw.replace(/\D/g, '');

    case 'URL': {
      // Host is case-insensitive, path is not.
      const m = /^(https?:\/\/)?([^/?#]+)([\s\S]*)$/i.exec(raw);
      if (!m) return raw;
      return `${(m[1] ?? '').toLowerCase()}${m[2].toLowerCase()}${m[3] ?? ''}`;
    }

    // Leading zeros are part of the identifier, so no numeric coercion here.
    case 'STUDENT_ID':
      return raw;

    default:
      return canonicalKey(raw);
  }
}

/**
 * Entity identity across a batch.
 * People are keyed by roster entry, so every spelling of one student shares a token.
 * Manual redactions stay separate per instance unless the instructor links them, since
 * we cannot tell whether two hand-selected phrases mean the same thing.
 */
export function entityKey(detection) {
  if (detection.type === 'PERSON' && detection.assignedRosterKey) {
    return `PERSON:${detection.assignedRosterKey}`;
  }
  if (detection.type === 'MANUAL') {
    return detection.linkKey
      ? `MANUAL:link:${detection.linkKey}`
      : `MANUAL:${detection.docId}:${detection.start}:${detection.end}`;
  }
  return `${detection.type}:${canonicalValue(detection.type, detection.matched)}`;
}
