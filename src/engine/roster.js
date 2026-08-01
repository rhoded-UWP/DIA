/**
 * Roster parsing and name matching.
 *
 * Matching student names is where a de-identification tool does the most damage when it
 * guesses. Two rules shape everything here:
 *
 *   - A partial name (first-only, surname-only) becomes an automatic match ONLY when it
 *     is unique across the whole roster. With a Jane Smith and a Jane Jones enrolled,
 *     the word "Jane" is reported for the instructor to assign, never auto-assigned.
 *   - Initials are never automatic.
 *
 * Matching runs against a folded view of the text (see normalize.js) whose offsets line
 * up 1:1 with the real text, so "O’Connor" in a paper matches an "O'Connor" roster entry
 * and still slices correctly.
 */

import { LIMITS } from './limits.js';
import {
  foldForMatching,
  canonicalKey,
  escapeRegExp,
  BOUNDARY_BEFORE,
  BOUNDARY_AFTER,
} from './normalize.js';

const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v', 'phd', 'ph.d.', 'md']);

// Header cells are compared with punctuation and spacing removed, so "Student ID",
// "student_id" and "studentid" are all the same label.
const HEADER_LABELS = new Set([
  'first', 'firstname', 'givenname', 'given', 'preferredname', 'preferred',
  'last', 'lastname', 'surname', 'familyname', 'family', 'sur',
  'name', 'fullname', 'studentname', 'displayname',
  'id', 'studentid', 'studentnumber', 'number', 'netid', 'login', 'username',
  'email', 'emailaddress', 'mail',
]);

function isHeaderCell(cell) {
  const key = String(cell).toLowerCase().replace(/[^a-z]/g, '');
  return key.length > 0 && HEADER_LABELS.has(key);
}

/** Split "Jane A. Smith Jr." into its parts, dropping generational suffixes. */
function splitName(fullName) {
  const parts = fullName.split(/\s+/).filter(Boolean);
  while (parts.length > 2 && SUFFIXES.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  if (parts.length === 0) return { first: '', middle: [], last: '' };
  if (parts.length === 1) return { first: parts[0], middle: [], last: '' };
  return { first: parts[0], middle: parts.slice(1, -1), last: parts[parts.length - 1] };
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function looksLikeId(s) {
  return /^[A-Za-z]{0,3}[0-9][0-9A-Za-z-]{2,15}$/.test(s) && /\d{3,}/.test(s);
}

/**
 * Accepts a pasted list or CSV, with or without a header row:
 *   Jane Smith
 *   Smith, Jane
 *   Jane Smith, 00123456, jsmith@example.edu
 *   first,last,id,email
 */
export function parseRoster(input) {
  const warnings = [];
  const entries = [];
  const lines = String(input)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (lines.length === 0) return { entries, warnings };

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const rows = lines.map((l) => l.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '')));

  // A header row is one whose cells are all field labels rather than data.
  let header = null;
  if (rows[0].length > 1 && rows[0].every(isHeaderCell)) {
    header = rows.shift().map((c) => c.toLowerCase());
  }

  for (const row of rows) {
    if (entries.length >= LIMITS.maxRosterEntries) {
      warnings.push(`Roster truncated at ${LIMITS.maxRosterEntries} entries.`);
      break;
    }
    const entry = header ? fromHeaderRow(row, header) : fromBareRow(row);
    if (!entry || !entry.fullName) continue;
    entries.push(entry);
  }

  return { entries: finalizeRoster(entries, warnings), warnings };
}

function fromHeaderRow(row, header) {
  let first = '', last = '', full = '', studentId = '', email = '';
  header.forEach((h, i) => {
    const v = row[i] ?? '';
    if (!v) return;
    if (/first|given/.test(h)) first = v;
    else if (/last|family|sur/.test(h)) last = v;
    else if (/name/.test(h)) full = v;
    else if (/mail/.test(h)) email = v;
    else if (/id|number|netid|login|username/.test(h)) studentId = v;
  });
  const fullName = full || [first, last].filter(Boolean).join(' ');
  return buildEntry(fullName, studentId, email);
}

function fromBareRow(row) {
  const cells = row.filter(Boolean);
  if (cells.length === 0) return null;

  // "Smith, Jane" arrives as two cells once we split on the comma.
  if (cells.length === 2 && !looksLikeEmail(cells[0]) && !looksLikeEmail(cells[1]) &&
      !looksLikeId(cells[0]) && !looksLikeId(cells[1]) &&
      cells.every((c) => /^[\p{L}][\p{L}\p{M}''\-. ]*$/u.test(c))) {
    return buildEntry(`${cells[1]} ${cells[0]}`, '', '');
  }

  let email = '', studentId = '', name = '';
  for (const c of cells) {
    if (!email && looksLikeEmail(c)) email = c;
    else if (!studentId && looksLikeId(c)) studentId = c;
    else if (c.length > name.length) name = c;
  }
  return buildEntry(name, studentId, email);
}

function buildEntry(fullName, studentId, email) {
  const clean = String(fullName).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const { first, middle, last } = splitName(clean);
  return {
    key: canonicalKey(clean) + '|' + canonicalKey(studentId || '') + '|' + canonicalKey(email || ''),
    fullName: clean,
    first,
    middle,
    last,
    studentId: studentId || '',
    email: email || '',
  };
}

/**
 * Decide which partial variants are safe to auto-apply, and flag collisions.
 * Runs once per roster so the whole batch shares one view of what is ambiguous.
 */
function finalizeRoster(entries, warnings) {
  const firstCounts = new Map();
  const lastCounts = new Map();
  const fullCounts = new Map();

  for (const e of entries) {
    if (e.first) firstCounts.set(canonicalKey(e.first), (firstCounts.get(canonicalKey(e.first)) ?? 0) + 1);
    if (e.last) lastCounts.set(canonicalKey(e.last), (lastCounts.get(canonicalKey(e.last)) ?? 0) + 1);
    fullCounts.set(canonicalKey(e.fullName), (fullCounts.get(canonicalKey(e.fullName)) ?? 0) + 1);
  }

  for (const [name, count] of fullCounts) {
    if (count > 1) {
      warnings.push(`Two roster entries normalize to the same name ("${name}"). They will share one token unless you edit the roster.`);
    }
  }

  for (const e of entries) {
    e.firstIsUnique = e.first ? firstCounts.get(canonicalKey(e.first)) === 1 : false;
    e.lastIsUnique = e.last ? lastCounts.get(canonicalKey(e.last)) === 1 : false;
  }
  return entries;
}

/**
 * "Jane Smith", with flexible whitespace so a name broken across a line still matches.
 * Case-insensitive.
 */
function fullNameSource(entry) {
  const first = escapeRegExp(foldForMatching(entry.first));
  const last = escapeRegExp(foldForMatching(entry.last));
  if (!last) return null;
  return `${first}\\s+${last}`;
}

/**
 * "Jane A. Smith" / "Jane Ann Smith" — first and last separated by middle names.
 *
 * Middle parts must be capitalized, which means this pattern is matched CASE-SENSITIVELY
 * and lives in its own category. Under a case-insensitive flag \p{Lu} also matches
 * lowercase letters, and the pattern would happily read "Jane wrote Smith" as one name.
 * The {1,3} bound keeps it linear.
 */
function fullNameWithMiddleSource(entry) {
  const first = escapeRegExp(foldForMatching(entry.first));
  const last = escapeRegExp(foldForMatching(entry.last));
  if (!last) return null;
  return `${first}(?:\\s+(?:\\p{Lu}\\.?|\\p{Lu}[\\p{L}\\p{M}'\\-]{1,20})){1,3}\\s+${last}`;
}

function lastCommaFirstSource(entry) {
  const first = escapeRegExp(foldForMatching(entry.first));
  const last = escapeRegExp(foldForMatching(entry.last));
  if (!last) return null;
  return `${last}\\s*,\\s*${first}`;
}

function initialLastSource(entry) {
  const first = escapeRegExp(foldForMatching(entry.first.slice(0, 1)));
  const last = escapeRegExp(foldForMatching(entry.last));
  if (!first || !last) return null;
  return `${first}\\.?\\s+${last}`;
}

/**
 * One alternation regex per variant category, longest alternative first — JavaScript
 * alternation is leftmost-first, so ordering by length approximates longest-wins at a
 * given position. Cross-category conflicts are settled later by resolveOverlaps().
 */
function buildCategoryMatcher(sources, { caseSensitive = false } = {}) {
  const usable = sources.filter((s) => s.source);
  if (usable.length === 0) return null;
  usable.sort((a, b) => b.source.length - a.source.length);
  const alternation = usable.map((s, i) => `(?<g${i}>${s.source})`).join('|');
  return {
    regex: new RegExp(`${BOUNDARY_BEFORE}(?:${alternation})${BOUNDARY_AFTER}`, caseSensitive ? 'gu' : 'giu'),
    owners: usable,
  };
}

function scanCategory(foldedText, matcher, kind, out) {
  if (!matcher) return;
  matcher.regex.lastIndex = 0;
  let m;
  while ((m = matcher.regex.exec(foldedText)) !== null) {
    if (m[0].length === 0) {
      matcher.regex.lastIndex += 1;
      continue;
    }
    // Which alternative fired? Named groups tell us without a second pass.
    let ownerIndex = -1;
    for (let i = 0; i < matcher.owners.length; i++) {
      if (m.groups?.[`g${i}`] !== undefined) {
        ownerIndex = i;
        break;
      }
    }
    if (ownerIndex === -1) continue;
    const owner = matcher.owners[ownerIndex];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      type: 'PERSON',
      kind,
      rosterKeys: owner.rosterKeys,
      needsDecision: owner.needsDecision,
      priority: owner.priority,
    });
  }
}

/**
 * Find every roster-derived name occurrence in one document.
 *
 * Detections carry `needsDecision` when the instructor must resolve them: ambiguous
 * partial names and initial forms. The protect flow refuses to export while any remain
 * unresolved — an unresolved ambiguity means a real name is still sitting in the text.
 */
export function matchRoster(text, roster) {
  const folded = foldForMatching(text);
  const detections = [];

  const fullSources = [];
  const middleNameSources = [];
  const uniquePartialSources = [];
  const ambiguousPartialSources = [];
  const initialSources = [];

  // Group ambiguous partials so one detection can list every candidate student.
  const firstNameGroups = new Map();
  const lastNameGroups = new Map();
  for (const e of roster) {
    if (e.first && !e.firstIsUnique) {
      const k = canonicalKey(e.first);
      if (!firstNameGroups.has(k)) firstNameGroups.set(k, { text: e.first, keys: [] });
      firstNameGroups.get(k).keys.push(e.key);
    }
    if (e.last && !e.lastIsUnique) {
      const k = canonicalKey(e.last);
      if (!lastNameGroups.has(k)) lastNameGroups.set(k, { text: e.last, keys: [] });
      lastNameGroups.get(k).keys.push(e.key);
    }
  }

  for (const e of roster) {
    const full = fullNameSource(e);
    if (full) fullSources.push({ source: full, rosterKeys: [e.key], needsDecision: false, priority: 100 });
    const lcf = lastCommaFirstSource(e);
    if (lcf) fullSources.push({ source: lcf, rosterKeys: [e.key], needsDecision: false, priority: 100 });
    const withMiddle = fullNameWithMiddleSource(e);
    if (withMiddle) middleNameSources.push({ source: withMiddle, rosterKeys: [e.key], needsDecision: false, priority: 100 });

    if (e.firstIsUnique) {
      uniquePartialSources.push({
        source: escapeRegExp(foldForMatching(e.first)),
        rosterKeys: [e.key], needsDecision: false, priority: 60,
      });
    }
    if (e.lastIsUnique) {
      uniquePartialSources.push({
        source: escapeRegExp(foldForMatching(e.last)),
        rosterKeys: [e.key], needsDecision: false, priority: 60,
      });
    }
    const init = initialLastSource(e);
    if (init) {
      // Outranks a bare unique surname: "J. Smith" is the longer, more specific span, and
      // letting the surname win would leave the initial sitting in the text.
      initialSources.push({ source: init, rosterKeys: [e.key], needsDecision: true, priority: 70 });
    }
  }

  for (const g of [...firstNameGroups.values(), ...lastNameGroups.values()]) {
    ambiguousPartialSources.push({
      source: escapeRegExp(foldForMatching(g.text)),
      rosterKeys: g.keys, needsDecision: true, priority: 50,
    });
  }

  scanCategory(folded, buildCategoryMatcher(fullSources), 'roster-full', detections);
  scanCategory(folded, buildCategoryMatcher(middleNameSources, { caseSensitive: true }), 'roster-full', detections);
  scanCategory(folded, buildCategoryMatcher(uniquePartialSources), 'roster-unique-partial', detections);
  scanCategory(folded, buildCategoryMatcher(ambiguousPartialSources), 'roster-ambiguous', detections);
  scanCategory(folded, buildCategoryMatcher(initialSources), 'roster-initial', detections);

  for (const d of detections) d.matched = text.slice(d.start, d.end);
  return detections;
}

/** Best-guess author for a document, from its filename and embedded metadata. */
export function guessAuthors(filename, metadataNames, roster) {
  const haystack = canonicalKey(`${filename} ${(metadataNames ?? []).join(' ')}`);
  const hits = [];
  for (const e of roster) {
    const full = canonicalKey(e.fullName);
    const reversed = canonicalKey(`${e.last} ${e.first}`);
    if (full && haystack.includes(full)) hits.push({ key: e.key, strength: 3 });
    else if (reversed && e.last && haystack.includes(reversed)) hits.push({ key: e.key, strength: 3 });
    else if (e.studentId && haystack.includes(canonicalKey(e.studentId))) hits.push({ key: e.key, strength: 2 });
    else if (e.email && haystack.includes(canonicalKey(e.email))) hits.push({ key: e.key, strength: 2 });
  }
  hits.sort((a, b) => b.strength - a.strength);
  return hits.map((h) => h.key);
}
