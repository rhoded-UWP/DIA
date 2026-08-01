/**
 * The protect pipeline, in two phases so the review screen sits between them.
 *
 *   analyzeBatch()        find candidates, decide nothing
 *   [instructor reviews]  toggle, assign ambiguous names, add manual redactions
 *   buildProtectedBatch() apply decisions, mint tokens, emit documents + map
 *
 * Splitting it this way means the tokens the instructor eventually ships are minted from
 * exactly the decisions they saw, and re-running the build after an edit is cheap.
 */

import { generateBatchId, makeToken, shuffledNumbers, findTokens, findTokenLikeText, TYPE_CODES } from './tokens.js';
import { matchRoster, guessAuthors } from './roster.js';
import { findPatterns } from './patterns.js';
import { resolveOverlaps } from './overlap.js';
import { entityKey } from './canonicalize.js';
import { LIMITS } from './limits.js';

export const SCHEMA_VERSION = 1;

export function detectionId(docId, start, end) {
  return `${docId}:${start}:${end}`;
}

/**
 * Phase 1. Pure detection over already-extracted, already-normalized text.
 *
 * @param {{docId:string, filename:string, text:string, metadataNames?:string[]}[]} docs
 * @param {object[]} roster from parseRoster()
 * @param {{enabled?:string[], idRegex?:RegExp|null}} options
 */
export function analyzeBatch(docs, roster, options = {}) {
  // The namespace must not already appear in anyone's text, or restoration would
  // rewrite words the student wrote. Collisions are astronomically unlikely at 40 bits;
  // this loop exists so that "unlikely" never becomes "silently wrong".
  let batchId = generateBatchId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const collides = docs.some((d) => findTokens(d.text).some((t) => t.batchId === batchId));
    if (!collides) break;
    batchId = generateBatchId();
  }

  const analyzed = docs.map((doc) => {
    const detections = [
      ...matchRoster(doc.text, roster),
      ...findPatterns(doc.text, options),
    ];
    const resolved = resolveOverlaps(detections).map((d) => ({
      ...d,
      docId: doc.docId,
      id: detectionId(doc.docId, d.start, d.end),
      matched: d.matched ?? doc.text.slice(d.start, d.end),
    }));

    return {
      docId: doc.docId,
      filename: doc.filename,
      text: doc.text,
      detections: resolved,
      authorGuesses: guessAuthors(doc.filename, doc.metadataNames ?? [], roster),
      tokenLike: findTokenLikeText(doc.text),
      warnings: doc.warnings ?? [],
    };
  });

  const totalDetections = analyzed.reduce((n, d) => n + d.detections.length, 0);
  const warnings = [];
  if (totalDetections > LIMITS.maxEntities) {
    warnings.push(`This batch produced ${totalDetections} detections, past the ${LIMITS.maxEntities} limit. Split it into smaller batches.`);
  }

  return { batchId, docs: analyzed, warnings };
}

/**
 * Detections the instructor still has to rule on. The protect flow blocks export while
 * this is non-empty: an unresolved ambiguity is a real name left in the document.
 */
export function unresolvedDecisions(analyzedDocs, decisions) {
  const open = [];
  for (const doc of analyzedDocs) {
    for (const d of doc.detections) {
      if (!d.needsDecision) continue;
      const decision = decisions[d.id];
      if (!decision || decision.action === 'undecided') open.push(d);
      else if (decision.action === 'assign' && !decision.rosterKey) open.push(d);
    }
  }
  return open;
}

/**
 * Phase 2. Apply decisions and produce the protected documents plus the map.
 *
 * @param {object} params
 * @param {string} params.batchId
 * @param {object[]} params.docs             output of analyzeBatch().docs
 * @param {object[]} params.roster
 * @param {Record<string, {action:string, rosterKey?:string, linkKey?:string}>} params.decisions
 * @param {object[]} [params.manual]         instructor-selected spans
 * @param {string}  [params.label]
 */
export function buildProtectedBatch({ batchId, docs, roster, decisions = {}, manual = [], label = '' }) {
  const rosterByKey = new Map(roster.map((e) => [e.key, e]));

  // --- collect the detections that will actually be replaced -------------------
  const accepted = [];
  for (const doc of docs) {
    const manualForDoc = manual
      .filter((m) => m.docId === doc.docId)
      .map((m) => ({
        ...m,
        type: 'MANUAL',
        kind: 'manual',
        priority: 200, // a hand-drawn selection always wins over an automatic guess
        needsDecision: false,
        id: detectionId(doc.docId, m.start, m.end),
        matched: doc.text.slice(m.start, m.end),
        docId: doc.docId,
      }));

    const candidates = [...doc.detections, ...manualForDoc];
    for (const d of candidates) {
      const decision = decisions[d.id];
      if (decision?.action === 'ignore') continue;
      if (d.needsDecision) {
        if (!decision) continue;
        if (decision.action === 'assign' && decision.rosterKey) {
          accepted.push({ ...d, assignedRosterKey: decision.rosterKey });
          continue;
        }
        if (decision.action === 'redact') {
          // Redact without naming: becomes a generic manual token, so the text is safe
          // even though feedback cannot be re-personalised for it.
          accepted.push({ ...d, type: 'MANUAL', kind: 'manual-unassigned' });
          continue;
        }
        continue;
      }
      if (d.type === 'PERSON') {
        accepted.push({ ...d, assignedRosterKey: decision?.rosterKey ?? d.rosterKeys?.[0] });
      } else {
        accepted.push({ ...d, linkKey: decision?.linkKey });
      }
    }
  }

  // Manual spans can sit on top of automatic ones; resolve per document.
  const byDoc = new Map();
  for (const d of accepted) {
    if (!byDoc.has(d.docId)) byDoc.set(d.docId, []);
    byDoc.get(d.docId).push(d);
  }
  const finalByDoc = new Map();
  for (const [docId, list] of byDoc) finalByDoc.set(docId, resolveOverlaps(list));

  // --- group into entities ------------------------------------------------------
  /** @type {Map<string, {type:string, restoreAs:string, canonical:string, occurrences:object[]}>} */
  const entities = new Map();
  for (const [docId, list] of finalByDoc) {
    for (const d of list) {
      const key = entityKey(d);
      if (!entities.has(key)) {
        entities.set(key, {
          key,
          type: d.type,
          // A person restores to their roster spelling; everything else restores to the
          // form it first appeared in, which reads more naturally than a normalized one.
          restoreAs: d.type === 'PERSON' && d.assignedRosterKey
            ? rosterByKey.get(d.assignedRosterKey)?.fullName ?? d.matched
            : d.matched,
          rosterKey: d.assignedRosterKey ?? null,
          occurrences: [],
        });
      }
      entities.get(key).occurrences.push({ docId, start: d.start, end: d.end, matched: d.matched, source: d.kind });
    }
  }

  // --- mint tokens --------------------------------------------------------------
  const byType = new Map();
  for (const e of entities.values()) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
  }
  for (const [type, list] of byType) {
    const code = TYPE_CODES[type] ?? TYPE_CODES.MANUAL;
    const numbers = shuffledNumbers(list.length);
    list.forEach((e, i) => {
      e.token = makeToken(batchId, code, numbers[i]);
    });
  }

  // Document numbers are shuffled for the same reason entity numbers are: file order
  // usually mirrors an alphabetical download from the LMS.
  const docNumbers = shuffledNumbers(docs.length);
  const docTokens = new Map();
  docs.forEach((doc, i) => docTokens.set(doc.docId, makeToken(batchId, TYPE_CODES.DOCUMENT, docNumbers[i])));

  // --- rewrite the text ---------------------------------------------------------
  const tokenByOccurrence = new Map();
  for (const e of entities.values()) {
    for (const occ of e.occurrences) {
      tokenByOccurrence.set(`${occ.docId}:${occ.start}:${occ.end}`, e.token);
    }
  }

  const protectedDocs = docs.map((doc) => {
    const list = finalByDoc.get(doc.docId) ?? [];
    let text = doc.text;
    // Right to left: every replacement shifts the offsets of everything after it.
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      const token = tokenByOccurrence.get(`${doc.docId}:${d.start}:${d.end}`);
      if (!token) continue;
      text = text.slice(0, d.start) + token + text.slice(d.end);
    }

    const docToken = docTokens.get(doc.docId);
    const authorTokens = authorTokensFor(doc, entities, decisions);
    const body = `## Document ${docToken}\n\n${text.trim()}\n`;

    return {
      docId: doc.docId,
      docToken,
      authorTokens,
      protectedFilename: protectedFilenameFor(batchId, docToken, authorTokens),
      text: body,
      originalFilename: doc.filename,
    };
  });

  const map = {
    app: 'dia',
    schemaVersion: SCHEMA_VERSION,
    batchId,
    label: String(label ?? '').slice(0, LIMITS.maxFieldLength),
    createdAt: new Date().toISOString(),
    documents: protectedDocs.map((p) => ({
      docId: p.docId,
      docToken: p.docToken,
      protectedFilename: p.protectedFilename,
      originalFilename: p.originalFilename,
      authorTokens: p.authorTokens,
    })),
    entities: [...entities.values()].map((e) => ({
      token: e.token,
      type: e.type,
      restoreAs: e.restoreAs,
      occurrences: e.occurrences.map((o) => ({ docId: o.docId, start: o.start, end: o.end, source: o.source })),
    })),
  };

  return { protectedDocs, map };
}

/** Tokens of the students identified as this document's author(s). */
function authorTokensFor(doc, entities, decisions) {
  const keys = new Set();
  for (const guess of doc.authorGuesses ?? []) keys.add(guess);
  // An explicit assignment in review outranks a filename guess.
  for (const d of doc.detections ?? []) {
    const decision = decisions[d.id];
    if (decision?.action === 'assign' && decision.rosterKey) keys.add(decision.rosterKey);
  }
  const tokens = [];
  for (const e of entities.values()) {
    if (e.rosterKey && keys.has(e.rosterKey) && !tokens.includes(e.token)) tokens.push(e.token);
  }
  return tokens;
}

/**
 * Protected filenames are built only from tokens. The original stem almost always
 * contains the student's name — including any part of it would undo the whole exercise.
 */
function protectedFilenameFor(batchId, docToken, authorTokens) {
  const doc = docToken.replace(/[[\]]/g, '');
  const author = authorTokens[0] ? '_' + authorTokens[0].replace(/[[\]]/g, '').replace(`PP_${batchId}_`, '') : '';
  return `${doc}${author}.md`;
}
