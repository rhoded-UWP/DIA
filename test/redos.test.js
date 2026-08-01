/**
 * Backtracking safety.
 *
 * Every recognizer runs over text a student wrote. A pattern that degrades exponentially
 * turns one uploaded paper into a frozen tab, so each one is fed the input shape most
 * likely to make it backtrack: a long run of characters it partially accepts, followed by
 * something that forces failure.
 *
 * The worker deadline is the real backstop in production; this suite exists so a pattern
 * edit that reintroduces catastrophic backtracking fails in CI instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOGNIZERS, findPatterns, compileIdFormat, findStudentIds } from '../src/engine/patterns.js';
import { matchRoster, parseRoster } from '../src/engine/roster.js';

const BUDGET_MS = 1000;

function timed(fn) {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

const adversarial = [
  ['long local part then no at-sign', 'a'.repeat(20000) + '!'],
  ['long local part with at-sign and no domain', 'a'.repeat(10000) + '@' + '!'],
  ['dotted domain that never terminates', 'x@' + 'a.'.repeat(8000) + '!'],
  ['digits with separators', '1-'.repeat(10000) + '!'],
  ['digit run', '9'.repeat(20000)],
  ['spaced digits', '1 '.repeat(10000)],
  ['dotted numbers', '1.'.repeat(10000) + '!'],
  ['capitalized word run', 'Aa '.repeat(6000) + '!'],
  ['url-ish run', 'https://' + 'a/'.repeat(10000)],
  ['mixed punctuation', '.-'.repeat(10000) + '@' + 'b'.repeat(1000)],
];

for (const recognizer of RECOGNIZERS) {
  test(`${recognizer.id} stays fast on adversarial input`, () => {
    for (const [label, input] of adversarial) {
      const ms = timed(() => recognizer.run(input, []));
      assert.ok(ms < BUDGET_MS, `${recognizer.id} took ${ms.toFixed(0)}ms on "${label}"`);
    }
  });
}

test('the full recognizer set stays fast on adversarial input', () => {
  for (const [label, input] of adversarial) {
    const ms = timed(() => findPatterns(input));
    assert.ok(ms < BUDGET_MS * 2, `findPatterns took ${ms.toFixed(0)}ms on "${label}"`);
  }
});

test('compiled student ID patterns stay fast', () => {
  const re = compileIdFormat('W#######');
  for (const [label, input] of adversarial) {
    const ms = timed(() => findStudentIds(input, re, []));
    assert.ok(ms < BUDGET_MS, `student ID scan took ${ms.toFixed(0)}ms on "${label}"`);
  }
});

test('roster matching stays fast with a full class and hostile text', () => {
  const names = Array.from({ length: 200 }, (_, i) => `Student${i} Surname${i}`).join('\n');
  const entries = parseRoster(names).entries;
  const hostile = 'Student1 '.repeat(5000) + 'x'.repeat(10000);
  const ms = timed(() => matchRoster(hostile, entries));
  assert.ok(ms < 3000, `roster matching took ${ms.toFixed(0)}ms`);
});
