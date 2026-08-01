/**
 * Validation for re-identification maps on import.
 *
 * A map is untrusted input even though this application wrote it: it round-trips through
 * a filesystem, an email attachment or a shared drive first. Everything is checked —
 * token grammar, filename safety, field lengths, duplicate tokens — and unknown fields
 * are rejected rather than ignored so a newer or tampered file cannot smuggle anything
 * past this point.
 */

import { LIMITS } from './limits.js';
import { isValidBatchId, parseToken, TYPE_CODES } from './tokens.js';
import { SCHEMA_VERSION } from './anonymize.js';

const KNOWN_TYPES = new Set(Object.keys(TYPE_CODES));

const TOP_LEVEL_FIELDS = new Set(['app', 'schemaVersion', 'batchId', 'label', 'createdAt', 'documents', 'entities']);
const DOC_FIELDS = new Set(['docId', 'docToken', 'protectedFilename', 'originalFilename', 'authorTokens']);
const ENTITY_FIELDS = new Set(['token', 'type', 'restoreAs', 'occurrences']);
const OCCURRENCE_FIELDS = new Set(['docId', 'start', 'end', 'source']);

class Errors {
  constructor() { this.list = []; }
  add(msg) { if (this.list.length < 50) this.list.push(msg); }
  get ok() { return this.list.length === 0; }
}

function checkUnknownFields(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.add(`${where}: unexpected field "${key}".`);
  }
}

function isBoundedString(v, max = LIMITS.maxFieldLength) {
  return typeof v === 'string' && v.length <= max;
}

/**
 * @param {unknown} input parsed JSON
 * @returns {{ok: boolean, errors: string[], map: object|null}}
 */
export function validateMap(input) {
  const errors = new Errors();

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['That file is not a re-identification map.'], map: null };
  }
  const map = input;

  if (map.app !== 'dia') errors.add('This file was not created by the De-identification Assistant.');

  if (!Number.isInteger(map.schemaVersion)) {
    errors.add('Missing schema version.');
  } else if (map.schemaVersion > SCHEMA_VERSION) {
    // Refuse rather than guess: a newer map may express things this build cannot honour.
    errors.add(`This map was created by a newer version of the app (schema ${map.schemaVersion}, this build understands ${SCHEMA_VERSION}). Update the app, or use the version that produced it.`);
  } else if (map.schemaVersion < 1) {
    errors.add('Unsupported schema version.');
  }

  if (!isValidBatchId(map.batchId)) errors.add('Missing or malformed batch id.');
  if (map.label !== undefined && !isBoundedString(map.label)) errors.add('Label is too long.');
  if (map.createdAt !== undefined && !isBoundedString(map.createdAt, 40)) errors.add('createdAt is malformed.');
  checkUnknownFields(map, TOP_LEVEL_FIELDS, 'map', errors);

  if (!Array.isArray(map.documents)) {
    errors.add('Missing documents list.');
  } else {
    validateDocuments(map, errors);
  }

  if (!Array.isArray(map.entities)) {
    errors.add('Missing entities list.');
  } else {
    validateEntities(map, errors);
  }

  return { ok: errors.ok, errors: errors.list, map: errors.ok ? map : null };
}

function validateDocuments(map, errors) {
  if (map.documents.length > LIMITS.maxBatchFiles) {
    errors.add(`Map lists ${map.documents.length} documents, past the ${LIMITS.maxBatchFiles} limit.`);
  }
  const seenIds = new Set();
  const seenTokens = new Set();

  for (const [i, doc] of map.documents.entries()) {
    const where = `document ${i + 1}`;
    if (typeof doc !== 'object' || doc === null) { errors.add(`${where}: not an object.`); continue; }
    checkUnknownFields(doc, DOC_FIELDS, where, errors);

    if (!isBoundedString(doc.docId, 40)) errors.add(`${where}: bad docId.`);
    else if (seenIds.has(doc.docId)) errors.add(`${where}: duplicate docId "${doc.docId}".`);
    else seenIds.add(doc.docId);

    const parsed = parseToken(doc.docToken ?? '');
    if (!parsed || parsed.typeCode !== TYPE_CODES.DOCUMENT) errors.add(`${where}: bad document token.`);
    else if (parsed.batchId !== map.batchId) errors.add(`${where}: document token belongs to batch ${parsed.batchId}, not ${map.batchId}.`);
    else if (seenTokens.has(doc.docToken)) errors.add(`${where}: duplicate document token.`);
    else seenTokens.add(doc.docToken);

    // Filenames from a map are written into a ZIP the user extracts, so they get the
    // same scrutiny as anything else that becomes a path.
    if (!isBoundedString(doc.protectedFilename, LIMITS.maxFilenameLength)) errors.add(`${where}: protected filename is missing or too long.`);
    if (doc.originalFilename !== undefined && !isBoundedString(doc.originalFilename, LIMITS.maxFilenameLength)) {
      errors.add(`${where}: original filename is too long.`);
    }
    if (!Array.isArray(doc.authorTokens)) {
      errors.add(`${where}: authorTokens must be a list.`);
    } else if (doc.authorTokens.length > 20) {
      errors.add(`${where}: too many author tokens.`);
    } else {
      for (const t of doc.authorTokens) {
        const p = parseToken(t ?? '');
        if (!p) errors.add(`${where}: malformed author token.`);
        else if (p.batchId !== map.batchId) errors.add(`${where}: author token from another batch.`);
      }
    }
  }
}

function validateEntities(map, errors) {
  if (map.entities.length > LIMITS.maxEntities) {
    errors.add(`Map lists ${map.entities.length} entities, past the ${LIMITS.maxEntities} limit.`);
  }
  const docIds = new Set(Array.isArray(map.documents) ? map.documents.map((d) => d?.docId) : []);
  const seenTokens = new Set();

  for (const [i, e] of map.entities.entries()) {
    const where = `entity ${i + 1}`;
    if (typeof e !== 'object' || e === null) { errors.add(`${where}: not an object.`); continue; }
    checkUnknownFields(e, ENTITY_FIELDS, where, errors);

    const parsed = parseToken(e.token ?? '');
    if (!parsed) {
      errors.add(`${where}: malformed token.`);
    } else if (parsed.batchId !== map.batchId) {
      errors.add(`${where}: token belongs to batch ${parsed.batchId}, not ${map.batchId}.`);
    } else if (seenTokens.has(e.token)) {
      // Two entities sharing a token would make restoration depend on iteration order.
      errors.add(`${where}: duplicate token ${e.token}.`);
    } else {
      seenTokens.add(e.token);
    }

    if (!KNOWN_TYPES.has(e.type)) errors.add(`${where}: unknown entity type "${e.type}".`);
    if (!isBoundedString(e.restoreAs)) errors.add(`${where}: restoreAs is missing or too long.`);

    if (e.occurrences !== undefined) {
      if (!Array.isArray(e.occurrences)) {
        errors.add(`${where}: occurrences must be a list.`);
      } else {
        for (const occ of e.occurrences.slice(0, 200)) {
          if (typeof occ !== 'object' || occ === null) { errors.add(`${where}: bad occurrence.`); break; }
          checkUnknownFields(occ, OCCURRENCE_FIELDS, `${where} occurrence`, errors);
          if (!docIds.has(occ.docId)) { errors.add(`${where}: occurrence points at unknown document "${occ.docId}".`); break; }
          if (!Number.isInteger(occ.start) || !Number.isInteger(occ.end) || occ.start < 0 || occ.end < occ.start) {
            errors.add(`${where}: occurrence offsets are invalid.`);
            break;
          }
        }
      }
    }
  }
}

/** Parse + validate in one step, with a size guard before JSON.parse. */
export function parseAndValidateMap(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.length > LIMITS.maxMapBytes) {
    return { ok: false, errors: ['Map file is missing or too large.'], map: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, errors: ['That file is not valid JSON. If it is encrypted, it should end in .json.enc.'], map: null };
  }
  return validateMap(parsed);
}
