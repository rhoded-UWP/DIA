import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster, matchRoster, guessAuthors } from '../src/engine/roster.js';
import { resolveOverlaps } from '../src/engine/overlap.js';

const roster = (text) => parseRoster(text).entries;

function matchedTexts(text, entries) {
  return resolveOverlaps(matchRoster(text, entries)).map((d) => d.matched);
}

test('parses plain name lists', () => {
  const entries = roster('Jane Smith\nRobert Jones\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].first, 'Jane');
  assert.equal(entries[0].last, 'Smith');
});

test('parses "Last, First"', () => {
  const entries = roster('Smith, Jane\nJones, Robert');
  assert.equal(entries[0].fullName, 'Jane Smith');
  assert.equal(entries[1].fullName, 'Robert Jones');
});

test('parses CSV with a header row', () => {
  const entries = roster('first,last,student id,email\nJane,Smith,00123456,jsmith@example.edu');
  assert.equal(entries[0].fullName, 'Jane Smith');
  assert.equal(entries[0].studentId, '00123456');
  assert.equal(entries[0].email, 'jsmith@example.edu');
});

test('parses CSV without a header row', () => {
  const entries = roster('Jane Smith, 00123456, jsmith@example.edu');
  assert.equal(entries[0].fullName, 'Jane Smith');
  assert.equal(entries[0].studentId, '00123456');
  assert.equal(entries[0].email, 'jsmith@example.edu');
});

test('drops generational suffixes when splitting names', () => {
  const entries = roster('Robert Downey Jr.');
  assert.equal(entries[0].first, 'Robert');
  assert.equal(entries[0].last, 'Downey');
});

test('finds a full name and a unique first name', () => {
  const entries = roster('Jane Smith\nRobert Jones');
  const found = matchedTexts('Jane Smith wrote this. Later, Jane revised it.', entries);
  assert.deepEqual(found, ['Jane Smith', 'Jane']);
});

test('a shared first name is never assigned automatically', () => {
  const entries = roster('Jane Smith\nJane Jones');
  const detections = resolveOverlaps(matchRoster('Jane submitted the paper.', entries));
  assert.equal(detections.length, 1);
  assert.equal(detections[0].needsDecision, true, 'ambiguous "Jane" must go to the instructor');
  assert.equal(detections[0].rosterKeys.length, 2, 'both candidates are offered');
});

test('a shared surname is never assigned automatically', () => {
  const entries = roster('Jane Smith\nRobert Smith');
  const detections = resolveOverlaps(matchRoster('Smith argues otherwise.', entries));
  assert.equal(detections.length, 1);
  assert.equal(detections[0].needsDecision, true);
});

test('a full name still resolves when its parts are ambiguous', () => {
  const entries = roster('Jane Smith\nJane Jones');
  const detections = resolveOverlaps(matchRoster('Jane Smith wrote this.', entries));
  assert.equal(detections.length, 1);
  assert.equal(detections[0].matched, 'Jane Smith');
  assert.equal(detections[0].needsDecision, false);
});

test('initials require confirmation', () => {
  const entries = roster('Jane Smith\nRobert Jones');
  const detections = resolveOverlaps(matchRoster('As J. Smith noted,', entries));
  const initial = detections.find((d) => d.kind === 'roster-initial');
  assert.ok(initial, 'initial form should be detected');
  assert.equal(initial.needsDecision, true);
});

test('a name is not found inside a longer word', () => {
  const entries = roster('Ann Lee');
  const found = matchedTexts('The anniversary of Anniston was unrelated.', entries);
  assert.deepEqual(found, [], '"Ann" must not match inside "anniversary" or "Anniston"');
});

test('one roster name contained in another resolves to the longer one', () => {
  const entries = roster('Jane Smith\nJane Smithson');
  const found = matchedTexts('Jane Smithson presented.', entries);
  assert.deepEqual(found, ['Jane Smithson']);
});

test('possessives keep their apostrophe outside the match', () => {
  const entries = roster('Jane Smith\nRobert Jones');
  const detections = resolveOverlaps(matchRoster("Jane's argument is strong.", entries));
  assert.equal(detections[0].matched, 'Jane', "the trailing 's stays in the text so restoration reads naturally");
});

test('curly and straight apostrophes both match', () => {
  const entries = roster("Siobhan O'Connor");
  assert.deepEqual(matchedTexts("Siobhan O’Connor wrote this.", entries), ["Siobhan O’Connor"]);
  assert.deepEqual(matchedTexts("Siobhan O'Connor wrote this.", entries), ["Siobhan O'Connor"]);
});

test('accented and non-Latin names match', () => {
  const entries = roster('José Muñoz\nNguyễn Vân\nAnne-Marie Dubois');
  assert.deepEqual(matchedTexts('José Muñoz submitted late.', entries), ['José Muñoz']);
  assert.deepEqual(matchedTexts('Nguyễn Vân did not.', entries), ['Nguyễn Vân']);
  assert.deepEqual(matchedTexts('Anne-Marie Dubois did.', entries), ['Anne-Marie Dubois']);
});

test('a name split across a line break still matches', () => {
  const entries = roster('Jane Smith');
  assert.deepEqual(matchedTexts('written by Jane\nSmith for class', entries), ['Jane\nSmith']);
});

test('a middle name or initial does not break the match', () => {
  const entries = roster('Jane Smith');
  assert.deepEqual(matchedTexts('Jane A. Smith wrote this.', entries), ['Jane A. Smith']);
  assert.deepEqual(matchedTexts('Jane Anne Smith wrote this.', entries), ['Jane Anne Smith']);
});

test('lowercase words between name parts are not swallowed', () => {
  // The regression this guards: a flexible middle pattern reading "Jane wrote Smith"
  // as one person and redacting the verb along with two names.
  const entries = roster('Jane Smith');
  const found = matchedTexts('Jane wrote that Smith disagreed.', entries);
  assert.ok(!found.includes('Jane wrote that Smith'), 'must not span the sentence');
  assert.deepEqual(found, ['Jane', 'Smith']);
});

test('matching is case-insensitive', () => {
  const entries = roster('Jane Smith');
  assert.deepEqual(matchedTexts('JANE SMITH submitted.', entries), ['JANE SMITH']);
});

test('duplicate roster names produce a warning', () => {
  const { warnings } = parseRoster('Jane Smith\nJane Smith');
  assert.ok(warnings.some((w) => /same name/i.test(w)));
});

test('author guessing uses filename and metadata', () => {
  const entries = roster('Jane Smith\nRobert Jones');
  const keys = guessAuthors('Jane Smith - Essay 2.docx', [], entries);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], entries[0].key);

  const fromMeta = guessAuthors('essay2.docx', ['Robert Jones'], entries);
  assert.equal(fromMeta[0], entries[1].key);
});
