import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMap, parseAndValidateMap } from '../src/engine/mapSchema.js';
import { SCHEMA_VERSION } from '../src/engine/anonymize.js';

const BATCH = 'ABCD2345';

function goodMap(overrides = {}) {
  return {
    app: 'dia',
    schemaVersion: SCHEMA_VERSION,
    batchId: BATCH,
    label: 'Essay 2',
    createdAt: '2026-08-01T00:00:00.000Z',
    documents: [{
      docId: 'd01',
      docToken: `[PP_${BATCH}_D01]`,
      protectedFilename: `PP_${BATCH}_D01_S07.md`,
      originalFilename: 'Jane Smith - Essay 2.docx',
      authorTokens: [`[PP_${BATCH}_S07]`],
    }],
    entities: [{
      token: `[PP_${BATCH}_S07]`,
      type: 'PERSON',
      restoreAs: 'Jane Smith',
      occurrences: [{ docId: 'd01', start: 0, end: 10, source: 'roster-full' }],
    }],
    ...overrides,
  };
}

test('a well-formed map validates', () => {
  const { ok, errors } = validateMap(goodMap());
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

test('a map from another application is refused', () => {
  const { ok, errors } = validateMap(goodMap({ app: 'something-else' }));
  assert.ok(!ok);
  assert.match(errors.join(' '), /not created by/i);
});

test('a newer schema version is refused rather than guessed at', () => {
  const { ok, errors } = validateMap(goodMap({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.ok(!ok);
  assert.match(errors.join(' '), /newer version/i);
});

test('duplicate tokens are rejected', () => {
  const map = goodMap();
  map.entities.push({ ...map.entities[0], restoreAs: 'Someone Else' });
  const { ok, errors } = validateMap(map);
  assert.ok(!ok);
  assert.match(errors.join(' '), /duplicate token/i);
});

test('tokens from another batch are rejected', () => {
  const map = goodMap();
  map.entities[0].token = '[PP_ZZZZ9999_S07]';
  const { ok, errors } = validateMap(map);
  assert.ok(!ok);
  assert.match(errors.join(' '), /belongs to batch/i);
});

test('malformed tokens are rejected', () => {
  const map = goodMap();
  map.entities[0].token = 'S07';
  assert.ok(!validateMap(map).ok);
});

test('unknown fields are rejected, not ignored', () => {
  const { ok, errors } = validateMap(goodMap({ extraField: 'surprise' }));
  assert.ok(!ok);
  assert.match(errors.join(' '), /unexpected field/i);
});

test('overlong fields are rejected', () => {
  const map = goodMap();
  map.entities[0].restoreAs = 'x'.repeat(5000);
  assert.ok(!validateMap(map).ok);
});

test('overlong filenames are rejected', () => {
  const map = goodMap();
  map.documents[0].protectedFilename = 'a'.repeat(5000);
  assert.ok(!validateMap(map).ok);
});

test('occurrences must point at a document in the map', () => {
  const map = goodMap();
  map.entities[0].occurrences[0].docId = 'nope';
  const { ok, errors } = validateMap(map);
  assert.ok(!ok);
  assert.match(errors.join(' '), /unknown document/i);
});

test('invalid occurrence offsets are rejected', () => {
  const map = goodMap();
  map.entities[0].occurrences[0] = { docId: 'd01', start: 10, end: 2, source: 'x' };
  assert.ok(!validateMap(map).ok);
});

test('duplicate document ids are rejected', () => {
  const map = goodMap();
  map.documents.push({ ...map.documents[0], docToken: `[PP_${BATCH}_D02]` });
  const { ok, errors } = validateMap(map);
  assert.ok(!ok);
  assert.match(errors.join(' '), /duplicate docId/i);
});

test('unknown entity types are rejected', () => {
  const map = goodMap();
  map.entities[0].type = 'MYSTERY';
  assert.ok(!validateMap(map).ok);
});

test('non-objects are refused politely', () => {
  for (const junk of [null, 42, 'text', [], undefined]) {
    const { ok, errors } = validateMap(junk);
    assert.ok(!ok);
    assert.ok(errors.length > 0);
  }
});

test('malformed JSON produces a readable error', () => {
  const { ok, errors } = parseAndValidateMap('{ not json');
  assert.ok(!ok);
  assert.match(errors.join(' '), /not valid JSON/i);
});

test('an oversized map file is refused before parsing', () => {
  const { ok, errors } = parseAndValidateMap('x'.repeat(21 * 1024 * 1024));
  assert.ok(!ok);
  assert.match(errors.join(' '), /too large/i);
});
