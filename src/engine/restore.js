/**
 * Re-identification.
 *
 * The guiding rule is that this step never guesses. It replaces tokens it can prove came
 * from this batch's map, and everything else — a token from another batch, a token the
 * map does not know, something that looks like a token an LLM reformatted — is reported
 * rather than silently substituted or silently ignored.
 *
 * Splitting one pasted response into per-student files happens only when the response
 * actually carries document headings. Without them there is no way to know where one
 * student's feedback ends, so a single restored file comes back instead.
 */

import { findTokens, TOKEN_LIKE_PATTERN } from './tokens.js';
import { sanitizeFilename, replaceExtension, makeUniqueNamer } from './filenames.js';

/** `## Document [PP_XXXXXXXX_D01]` at the start of a line, any heading level. */
const DOC_HEADING = /^[ \t]{0,3}#{1,6}[ \t]*[^\n]*?(\[PP_[A-Z0-9]{8}_D\d{2,4}\])[^\n]*$/gm;

/**
 * @param {object} params
 * @param {object} params.map              validated re-identification map
 * @param {{name:string, text:string}[]} params.inputs
 * @param {boolean} [params.lenient]       repair case/spacing damage to tokens
 */
export function restore({ map, inputs, lenient = false }) {
  const entityByToken = new Map(map.entities.map((e) => [e.token, e]));
  const docByToken = new Map(map.documents.map((d) => [d.docToken, d]));

  const report = {
    batchId: map.batchId,
    expectedDocuments: map.documents.length,
    foundDocuments: 0,
    missingDocuments: [],
    duplicateDocuments: [],
    replacements: 0,
    unknownTokens: [],
    wrongBatchTokens: [],
    alteredTokenSuspects: [],
    repairedTokens: [],
    splitMode: 'single',
  };

  const sections = splitIntoSections(inputs, docByToken, report);

  const namer = makeUniqueNamer();
  const seenDocs = new Map();
  const outputs = [];

  for (const section of sections) {
    const { text, replacements } = replaceTokens(section.text, {
      entityByToken, mapBatchId: map.batchId, lenient, report,
    });
    report.replacements += replacements;

    const doc = section.docToken ? docByToken.get(section.docToken) : null;
    if (doc) {
      seenDocs.set(doc.docId, (seenDocs.get(doc.docId) ?? 0) + 1);
    }

    outputs.push({
      docId: doc?.docId ?? null,
      filename: namer(outputFilename(doc, section, outputs.length)),
      text,
    });
  }

  for (const doc of map.documents) {
    const count = seenDocs.get(doc.docId) ?? 0;
    if (count === 0) report.missingDocuments.push({ docId: doc.docId, docToken: doc.docToken, originalFilename: doc.originalFilename });
    if (count > 1) report.duplicateDocuments.push({ docId: doc.docId, docToken: doc.docToken, count });
  }
  report.foundDocuments = seenDocs.size;

  return { outputs, report };
}

function outputFilename(doc, section, index) {
  if (doc?.originalFilename) {
    return replaceExtension(sanitizeFilename(doc.originalFilename), '') + ' - feedback.md';
  }
  if (section.sourceName) {
    return replaceExtension(sanitizeFilename(section.sourceName), '') + ' - restored.md';
  }
  return `restored-feedback-${index + 1}.md`;
}

/**
 * Decide whether we are splitting a batch response or restoring text as-is.
 * Splitting requires headings we emitted ourselves; nothing else is reliable enough.
 */
function splitIntoSections(inputs, docByToken, report) {
  const sections = [];

  for (const input of inputs) {
    const headings = [...input.text.matchAll(DOC_HEADING)]
      .map((m) => ({ index: m.index, docToken: m[1] }))
      .filter((h) => docByToken.has(h.docToken));

    if (headings.length <= 1) {
      sections.push({
        text: input.text,
        sourceName: input.name,
        // A file with exactly one heading still identifies its student.
        docToken: headings[0]?.docToken ?? soleDocTokenIn(input.text, docByToken),
      });
      continue;
    }

    report.splitMode = 'structured';
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index : input.text.length;
      sections.push({
        text: input.text.slice(start, end).trim() + '\n',
        sourceName: input.name,
        docToken: headings[i].docToken,
      });
    }
  }

  return sections;
}

/** A document token appearing anywhere, but only if it is the only one present. */
function soleDocTokenIn(text, docByToken) {
  const found = new Set(findTokens(text).map((t) => t.token).filter((t) => docByToken.has(t)));
  return found.size === 1 ? [...found][0] : null;
}

function replaceTokens(text, { entityByToken, mapBatchId, lenient, report }) {
  const found = findTokens(text);
  let replacements = 0;
  let out = text;

  // Right to left so earlier offsets stay valid.
  for (let i = found.length - 1; i >= 0; i--) {
    const t = found[i];
    if (t.batchId !== mapBatchId) {
      recordOnce(report.wrongBatchTokens, t.token);
      continue;
    }
    const entity = entityByToken.get(t.token);
    if (!entity) {
      // Document headings are ours but have no entity; they are not an error.
      if (t.typeCode !== 'D') recordOnce(report.unknownTokens, t.token);
      continue;
    }
    out = out.slice(0, t.start) + entity.restoreAs + out.slice(t.end);
    replacements++;
  }

  const suspects = findAlteredTokens(out, mapBatchId, entityByToken);
  for (const s of suspects) {
    if (lenient && s.repairTo) {
      out = out.slice(0, s.start) + entityByToken.get(s.repairTo).restoreAs + out.slice(s.end);
      replacements++;
      report.repairedTokens.push({ found: s.text, repairedTo: s.repairTo });
    } else {
      recordOnce(report.alteredTokenSuspects, s.text, s);
    }
  }

  return { text: out, replacements };
}

/**
 * Token-shaped text that is not a valid token — lowercased, spaced out, or missing its
 * brackets. Reported by default; only repaired when the instructor opts in, because a
 * wrong repair writes a real student's name into another student's feedback.
 */
export function findAlteredTokens(text, mapBatchId, entityByToken) {
  const suspects = [];
  const re = new RegExp(TOKEN_LIKE_PATTERN.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (/^\[PP_[A-Z0-9]{8}_[A-Z]{1,3}\d{2,4}\]$/.test(raw)) continue; // already valid

    const normalized = `[PP_${m[1].toUpperCase()}_${m[2].toUpperCase()}${m[3].padStart(2, '0')}]`;
    const belongsHere = m[1].toUpperCase() === mapBatchId;
    suspects.push({
      text: raw,
      start: m.index,
      end: m.index + raw.length,
      repairTo: belongsHere && entityByToken.has(normalized) ? normalized : null,
      sameBatch: belongsHere,
    });
  }
  return suspects;
}

function recordOnce(list, value, extra) {
  if (typeof value === 'string' && list.some((v) => (typeof v === 'string' ? v : v.text) === value)) return;
  list.push(extra ? { text: value, sameBatch: extra.sameBatch } : value);
}

/** Human-readable summary of what the restore did and did not do. */
export function summarizeReport(report) {
  const lines = [];
  lines.push(`Batch ${report.batchId}: ${report.replacements} token${report.replacements === 1 ? '' : 's'} restored.`);
  lines.push(`Documents expected: ${report.expectedDocuments}. Found in feedback: ${report.foundDocuments}.`);
  if (report.missingDocuments.length) {
    lines.push(`No feedback found for ${report.missingDocuments.length} document(s).`);
  }
  if (report.duplicateDocuments.length) {
    lines.push(`${report.duplicateDocuments.length} document(s) appeared more than once.`);
  }
  if (report.wrongBatchTokens.length) {
    lines.push(`${report.wrongBatchTokens.length} token(s) belong to a different batch and were left alone.`);
  }
  if (report.unknownTokens.length) {
    lines.push(`${report.unknownTokens.length} token(s) are not in this map and were left alone.`);
  }
  if (report.alteredTokenSuspects.length) {
    lines.push(`${report.alteredTokenSuspects.length} token(s) look damaged and were left alone.`);
  }
  if (report.repairedTokens.length) {
    lines.push(`${report.repairedTokens.length} damaged token(s) were repaired because lenient matching is on.`);
  }
  return lines;
}
