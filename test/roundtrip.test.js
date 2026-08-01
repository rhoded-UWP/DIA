/**
 * Protect -> (simulated LLM) -> restore.
 *
 * The taxonomy from the plan: known-value recall, false positives, restoration
 * integrity, and failure handling. "Byte-perfect restoration" is deliberately not
 * asserted anywhere — every spelling of a student's name collapses to their roster
 * spelling by design, so "Jane's" comes back as "Jane Smith's".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/engine/roster.js';
import { analyzeBatch, buildProtectedBatch, unresolvedDecisions } from '../src/engine/anonymize.js';
import { restore } from '../src/engine/restore.js';
import { compileIdFormat } from '../src/engine/patterns.js';
import { normalizeDocumentText } from '../src/engine/normalize.js';

const ROSTER = 'Jane Smith, 00123456, jsmith@example.edu\nRobert Jones, 00998877, rjones@example.edu\nJosé Muñoz, 00445566, jmunoz@example.edu';

function protectDocs(docs, { rosterText = ROSTER, decisions = {}, manual = [], options = {} } = {}) {
  const roster = parseRoster(rosterText).entries;
  const prepared = docs.map((d, i) => ({
    docId: d.docId ?? `d${String(i + 1).padStart(2, '0')}`,
    filename: d.filename,
    text: normalizeDocumentText(d.text),
    metadataNames: d.metadataNames ?? [],
  }));
  const analyzed = analyzeBatch(prepared, roster, options);
  const built = buildProtectedBatch({
    batchId: analyzed.batchId, docs: analyzed.docs, roster, decisions, manual,
  });
  return { ...built, analyzed, roster, batchId: analyzed.batchId };
}

const FIXTURE = {
  filename: 'Jane Smith - Essay 2.docx',
  text: `Jane Smith
CS 1430, Section 2
jsmith@example.edu | (608) 555-1212 | ID 00123456

Jane's essay argues that the assigned reading overstates its case. As Smith notes in
her earlier draft, the evidence in chapter three is thin. Robert Jones disagreed.`,
};

test('known values do not survive protection', () => {
  const { protectedDocs } = protectDocs([FIXTURE], { options: { idRegex: compileIdFormat('########') } });
  const out = protectedDocs[0].text;
  for (const secret of ['Jane', 'Smith', 'jsmith@example.edu', '555-1212', '00123456', 'Robert', 'Jones']) {
    assert.ok(!out.includes(secret), `protected text still contains "${secret}"`);
  }
});

test('the protected filename reveals nothing from the original', () => {
  const { protectedDocs } = protectDocs([FIXTURE]);
  const name = protectedDocs[0].protectedFilename;
  assert.ok(!/jane|smith|essay/i.test(name), `filename "${name}" leaks the original`);
  assert.match(name, /^PP_[A-Z0-9]{8}_D\d{2}/);
});

test('one student gets one token across the whole batch', () => {
  const { protectedDocs, map } = protectDocs([
    { filename: 'a.docx', text: 'Jane Smith wrote paper one.' },
    { filename: 'b.docx', text: 'Jane Smith also wrote paper two.' },
  ]);
  const person = map.entities.filter((e) => e.type === 'PERSON');
  assert.equal(person.length, 1, 'the same student must not get two tokens');
  assert.ok(protectedDocs[0].text.includes(person[0].token));
  assert.ok(protectedDocs[1].text.includes(person[0].token));
});

test('the same email in different cases and documents shares one token', () => {
  const { map } = protectDocs([
    { filename: 'a.docx', text: 'Contact JSmith@Example.edu for details.' },
    { filename: 'b.docx', text: 'Also jsmith@example.edu works.' },
  ]);
  assert.equal(map.entities.filter((e) => e.type === 'EMAIL').length, 1);
});

test('phone numbers written differently share one token', () => {
  const { map } = protectDocs([
    { filename: 'a.docx', text: 'Reach me at (608) 555-1212 or +1 608.555.1212.' },
  ]);
  assert.equal(map.entities.filter((e) => e.type === 'PHONE').length, 1);
});

test('every occurrence in the map points at real text', () => {
  const { map, analyzed } = protectDocs([FIXTURE]);
  const byId = new Map(analyzed.docs.map((d) => [d.docId, d.text]));
  for (const entity of map.entities) {
    for (const occ of entity.occurrences) {
      const slice = byId.get(occ.docId).slice(occ.start, occ.end);
      assert.ok(slice.length > 0, 'occurrence offsets must address real text');
    }
  }
});

test('feedback restores to canonical names', () => {
  const { map, protectedDocs } = protectDocs([FIXTURE]);
  const studentToken = map.entities.find((e) => e.type === 'PERSON' && e.restoreAs === 'Jane Smith').token;
  const feedback = `${protectedDocs[0].text.split('\n')[0]}\n\nGood work, ${studentToken}. ${studentToken}'s thesis is clear.`;

  const { outputs, report } = restore({ map, inputs: [{ name: 'feedback.md', text: feedback }] });
  assert.equal(outputs.length, 1);
  assert.ok(outputs[0].text.includes('Good work, Jane Smith.'));
  assert.ok(outputs[0].text.includes("Jane Smith's thesis"));
  assert.equal(report.replacements, 2);
  assert.equal(report.unknownTokens.length, 0);
  assert.equal(report.wrongBatchTokens.length, 0);
});

test('restored filenames come back from the original names', () => {
  const { map, protectedDocs } = protectDocs([FIXTURE]);
  const { outputs } = restore({ map, inputs: [{ name: 'x.md', text: protectedDocs[0].text }] });
  assert.equal(outputs[0].filename, 'Jane Smith - Essay 2 - feedback.md');
});

test('a batch response splits on document headings', () => {
  const { map, protectedDocs } = protectDocs([
    { filename: 'Jane Smith - Essay.docx', text: 'Jane Smith wrote this.' },
    { filename: 'Robert Jones - Essay.docx', text: 'Robert Jones wrote this.' },
    { filename: 'Jose Munoz - Essay.docx', text: 'José Muñoz wrote this.' },
  ]);
  const blob = protectedDocs
    .map((p) => `## Document ${p.docToken}\n\nSolid argument overall.\n`)
    .join('\n');

  const { outputs, report } = restore({ map, inputs: [{ name: 'all-feedback.md', text: blob }] });
  assert.equal(report.splitMode, 'structured');
  assert.equal(outputs.length, 3);
  assert.equal(report.foundDocuments, 3);
  assert.equal(report.missingDocuments.length, 0);
  assert.deepEqual(outputs.map((o) => o.filename).sort(), [
    'Jane Smith - Essay - feedback.md',
    'Jose Munoz - Essay - feedback.md',
    'Robert Jones - Essay - feedback.md',
  ]);
});

test('a response without headings is not split', () => {
  const { map } = protectDocs([
    { filename: 'a.docx', text: 'Jane Smith wrote this.' },
    { filename: 'b.docx', text: 'Robert Jones wrote this.' },
  ]);
  const { outputs, report } = restore({ map, inputs: [{ name: 'blob.md', text: 'Everyone did fine this week.' }] });
  assert.equal(outputs.length, 1, 'splitting must not be guessed');
  assert.equal(report.splitMode, 'single');
  assert.equal(report.missingDocuments.length, 2, 'and the absence is reported');
});

test('missing and duplicated documents are both reported', () => {
  const { map, protectedDocs } = protectDocs([
    { filename: 'a.docx', text: 'Jane Smith wrote this.' },
    { filename: 'b.docx', text: 'Robert Jones wrote this.' },
  ]);
  const first = protectedDocs[0].docToken;
  const blob = `## Document ${first}\n\nGood.\n\n## Document ${first}\n\nAlso good.\n`;
  const { report } = restore({ map, inputs: [{ name: 'f.md', text: blob }] });
  assert.equal(report.duplicateDocuments.length, 1);
  assert.equal(report.missingDocuments.length, 1);
});

test('a token from another batch is reported and left alone', () => {
  const { map } = protectDocs([FIXTURE]);
  const foreign = '[PP_ZZZZ9999_S01]';
  const { outputs, report } = restore({ map, inputs: [{ name: 'f.md', text: `Nice work ${foreign}.` }] });
  assert.ok(outputs[0].text.includes(foreign), 'must not substitute a token we did not mint');
  assert.deepEqual(report.wrongBatchTokens, [foreign]);
});

test('an unknown token from this batch is reported and left alone', () => {
  const { map, batchId } = protectDocs([FIXTURE]);
  const unknown = `[PP_${batchId}_S99]`;
  const { outputs, report } = restore({ map, inputs: [{ name: 'f.md', text: `Nice work ${unknown}.` }] });
  assert.ok(outputs[0].text.includes(unknown));
  assert.deepEqual(report.unknownTokens, [unknown]);
});

test('a damaged token is reported, and only repaired when asked', () => {
  const { map, batchId } = protectDocs([FIXTURE]);
  const real = map.entities.find((e) => e.restoreAs === 'Jane Smith').token;
  const damaged = real.toLowerCase();
  const input = [{ name: 'f.md', text: `Nice work ${damaged}.` }];

  const strict = restore({ map, inputs: input });
  assert.equal(strict.report.alteredTokenSuspects.length, 1);
  assert.ok(strict.outputs[0].text.includes(damaged), 'strict mode changes nothing');
  assert.ok(!strict.outputs[0].text.includes('Jane Smith'));

  const lenient = restore({ map, inputs: input, lenient: true });
  assert.equal(lenient.report.repairedTokens.length, 1);
  assert.ok(lenient.outputs[0].text.includes('Jane Smith'));
  assert.equal(batchId.length, 8);
});

test("text a student wrote that looks like a token is never rewritten", () => {
  const planted = '[PP_ABCD2345_S01]';
  const { protectedDocs, map } = protectDocs([
    { filename: 'a.docx', text: `Jane Smith explains that placeholders such as ${planted} are common.` },
  ]);
  assert.ok(protectedDocs[0].text.includes(planted), 'the student\'s own text survives protection');

  const { outputs, report } = restore({ map, inputs: [{ name: 'f.md', text: protectedDocs[0].text }] });
  assert.ok(outputs[0].text.includes(planted), 'and is not replaced during restoration');
  assert.deepEqual(report.wrongBatchTokens, [planted]);
});

test('an unresolved ambiguous name blocks the export', () => {
  const roster = 'Jane Smith\nJane Jones';
  const { analyzed } = protectDocs([{ filename: 'a.docx', text: 'Jane submitted the paper.' }], { rosterText: roster });
  const open = unresolvedDecisions(analyzed.docs, {});
  assert.equal(open.length, 1);

  const resolved = unresolvedDecisions(analyzed.docs, { [open[0].id]: { action: 'redact' } });
  assert.equal(resolved.length, 0);
});

test('an ambiguous name assigned to a student uses that student\'s token', () => {
  const rosterText = 'Jane Smith\nJane Jones';
  const roster = parseRoster(rosterText).entries;
  const prepared = [{ docId: 'd01', filename: 'a.docx', text: 'Jane submitted the paper.', metadataNames: [] }];
  const analyzed = analyzeBatch(prepared, roster, {});
  const ambiguous = analyzed.docs[0].detections.find((d) => d.needsDecision);

  const built = buildProtectedBatch({
    batchId: analyzed.batchId,
    docs: analyzed.docs,
    roster,
    decisions: { [ambiguous.id]: { action: 'assign', rosterKey: roster[0].key } },
  });
  const entity = built.map.entities.find((e) => e.type === 'PERSON');
  assert.equal(entity.restoreAs, 'Jane Smith');
  assert.ok(built.protectedDocs[0].text.includes(entity.token));
  assert.ok(!built.protectedDocs[0].text.includes('Jane'));
});

test('an ambiguous name redacted generically cannot be re-personalised', () => {
  const rosterText = 'Jane Smith\nJane Jones';
  const roster = parseRoster(rosterText).entries;
  const analyzed = analyzeBatch([{ docId: 'd01', filename: 'a.docx', text: 'Jane submitted the paper.' }], roster, {});
  const ambiguous = analyzed.docs[0].detections.find((d) => d.needsDecision);

  const built = buildProtectedBatch({
    batchId: analyzed.batchId, docs: analyzed.docs, roster,
    decisions: { [ambiguous.id]: { action: 'redact' } },
  });
  assert.ok(!built.protectedDocs[0].text.includes('Jane'), 'the name is gone either way');
  const entity = built.map.entities[0];
  assert.equal(entity.type, 'MANUAL');
  assert.equal(entity.restoreAs, 'Jane');
});

test('a detection the instructor rejects is left in the text', () => {
  const roster = parseRoster('Jane Smith').entries;
  const analyzed = analyzeBatch([{ docId: 'd01', filename: 'a.docx', text: 'Adam Smith wrote about markets.' }], roster, {});
  const surname = analyzed.docs[0].detections.find((d) => d.matched === 'Smith');
  assert.ok(surname, 'a unique surname is detected even in a citation');

  const built = buildProtectedBatch({
    batchId: analyzed.batchId, docs: analyzed.docs, roster,
    decisions: { [surname.id]: { action: 'ignore' } },
  });
  assert.ok(built.protectedDocs[0].text.includes('Adam Smith'));
});

test('a manual redaction wins over an automatic detection', () => {
  const roster = parseRoster('Jane Smith').entries;
  const text = 'Jane Smith is the only student from Iceland in the program.';
  const analyzed = analyzeBatch([{ docId: 'd01', filename: 'a.docx', text }], roster, {});
  const start = text.indexOf('the only student from Iceland');
  const built = buildProtectedBatch({
    batchId: analyzed.batchId, docs: analyzed.docs, roster,
    manual: [{ docId: 'd01', start, end: start + 'the only student from Iceland'.length }],
  });
  assert.ok(!built.protectedDocs[0].text.includes('Iceland'), 'indirect identifiers can be removed by hand');
});

test('protection is stable when re-run with the same decisions', () => {
  const roster = parseRoster(ROSTER).entries;
  const prepared = [{ docId: 'd01', filename: FIXTURE.filename, text: normalizeDocumentText(FIXTURE.text) }];
  const analyzed = analyzeBatch(prepared, roster, {});
  const a = buildProtectedBatch({ batchId: analyzed.batchId, docs: analyzed.docs, roster });
  const b = buildProtectedBatch({ batchId: analyzed.batchId, docs: analyzed.docs, roster });
  // Token numbers are randomised per build, so compare structure rather than text.
  assert.equal(a.map.entities.length, b.map.entities.length);
  assert.deepEqual(
    a.map.entities.map((e) => e.restoreAs).sort(),
    b.map.entities.map((e) => e.restoreAs).sort(),
  );
});
