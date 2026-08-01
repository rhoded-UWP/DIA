import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateBatchId, isValidBatchId, makeToken, parseToken, shuffledNumbers,
  findTokens, hasTokenCollision, findTokenLikeText, BATCH_ID_LENGTH,
} from '../src/engine/tokens.js';

test('batch ids are 8 base32 characters', () => {
  for (let i = 0; i < 50; i++) {
    const id = generateBatchId();
    assert.equal(id.length, BATCH_ID_LENGTH);
    assert.ok(isValidBatchId(id), `${id} should be valid`);
    assert.ok(!/[ILOU]/.test(id), 'ambiguous letters are excluded from the alphabet');
  }
});

test('batch ids do not repeat across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(generateBatchId());
  assert.equal(seen.size, 2000, 'no collisions expected at 40 bits over 2000 draws');
});

test('tokens round-trip through parseToken', () => {
  const id = generateBatchId();
  const token = makeToken(id, 'S', 7);
  assert.equal(token, `[PP_${id}_S07]`);
  assert.deepEqual(parseToken(token), { batchId: id, typeCode: 'S', number: 7 });
});

test('makeToken rejects malformed input', () => {
  assert.throws(() => makeToken('short', 'S', 1));
  assert.throws(() => makeToken(generateBatchId(), 'lower', 1));
  assert.throws(() => makeToken(generateBatchId(), 'S', 0));
});

test('token numbers are shuffled, not sequential', () => {
  // A CSPRNG shuffle can produce the identity permutation; over 30 draws of 20 elements
  // it effectively never does. This is the property that stops roster order leaking.
  let identical = 0;
  for (let i = 0; i < 30; i++) {
    const nums = shuffledNumbers(20);
    assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: 20 }, (_, n) => n + 1));
    if (nums.every((n, idx) => n === idx + 1)) identical++;
  }
  assert.ok(identical <= 1, 'shuffle should not keep returning roster order');
});

test('findTokens reports offsets', () => {
  const id = generateBatchId();
  const text = `Hello ${makeToken(id, 'S', 1)} and ${makeToken(id, 'EM', 2)}.`;
  const found = findTokens(text);
  assert.equal(found.length, 2);
  assert.equal(text.slice(found[0].start, found[0].end), found[0].token);
  assert.equal(found[1].typeCode, 'EM');
});

test('collision guard sees a pre-existing token of the same batch', () => {
  const id = 'ABCD2345';
  assert.ok(hasTokenCollision(`student wrote [PP_${id}_S01] on purpose`, id));
  assert.ok(!hasTokenCollision(`unrelated [PP_ZZZZ9999_S01]`, id));
});

test('token-like text is detected even when damaged', () => {
  const damaged = 'see [pp_abcd2345_s01] and PP_ABCD2345_S02 for details';
  const found = findTokenLikeText(damaged);
  assert.equal(found.length, 2);
});
