import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findEmails, findPhones, findSsns, findCreditCards, findIpAddresses,
  findUrls, findAddresses, findDatesOfBirth, findStudentIds,
  compileIdFormat, compileIdRegex, looksUnsafeRegex, luhnValid, findPatterns, RECOGNIZERS,
} from '../src/engine/patterns.js';

const RECOGNIZER_IDS = RECOGNIZERS.map((r) => r.id);

const texts = (dets) => dets.map((d) => d.matched);

test('finds email addresses and trims trailing punctuation', () => {
  assert.deepEqual(texts(findEmails('Write to jsmith@example.edu.')), ['jsmith@example.edu']);
  assert.deepEqual(texts(findEmails('a.b+tag@sub.example.co.uk works')), ['a.b+tag@sub.example.co.uk']);
});

test('rejects things that only look like email', () => {
  assert.deepEqual(texts(findEmails('read@home is not an address')), []);
  assert.deepEqual(texts(findEmails('costs 5@10 each')), []);
});

test('finds US phone numbers in several shapes', () => {
  const found = texts(findPhones('Call (608) 555-1212 or 608-555-1212 or +1 608.555.1212 today'));
  assert.equal(found.length, 3);
});

test('finds punctuated SSNs but not bare digit runs', () => {
  assert.deepEqual(texts(findSsns('SSN 123-45-6789 here')), ['123-45-6789']);
  assert.deepEqual(texts(findSsns('order 123456789 shipped')), [], 'bare 9 digits is usually a student ID');
});

test('credit cards must pass Luhn', () => {
  assert.ok(luhnValid('4111111111111111'));
  assert.deepEqual(texts(findCreditCards('card 4111 1111 1111 1111 on file')), ['4111 1111 1111 1111']);
  assert.deepEqual(texts(findCreditCards('id 1234 5678 9012 3456 assigned')), [], 'fails Luhn, so not a card');
});

test('IP addresses validate octet range', () => {
  assert.deepEqual(texts(findIpAddresses('host 192.168.1.10 online')), ['192.168.1.10']);
  assert.deepEqual(texts(findIpAddresses('version 999.1.1.1 released')), []);
});

test('URLs stop at sentence punctuation', () => {
  assert.deepEqual(texts(findUrls('See https://example.edu/page.')), ['https://example.edu/page']);
});

test('street addresses need a street type', () => {
  assert.deepEqual(texts(findAddresses('at 1 University Plaza Drive today')), ['1 University Plaza Drive']);
  assert.deepEqual(texts(findAddresses('in 1999 many things happened')), []);
});

test('an address at the end of a sentence leaves the full stop behind', () => {
  // Regression: the match used to include a trailing period so "St." could be matched
  // whole, which swallowed the sentence's punctuation and left "The clinic is at [TOKEN]"
  // with no full stop.
  assert.deepEqual(texts(findAddresses('The clinic is at 4820 North Oakland Avenue.')), ['4820 North Oakland Avenue']);
  assert.deepEqual(texts(findAddresses('She lives at 12 Oak St. It is nearby.')), ['12 Oak St']);
  assert.deepEqual(texts(findAddresses('Mail it to 90 Elm Rd, apartment 4.')), ['90 Elm Rd']);
});

test('no recognizer swallows the punctuation that follows it', () => {
  // The same mistake is easy to reintroduce in any pattern with an optional trailing
  // character, so every recognizer is checked at the end of a sentence.
  const cases = [
    ['Write to jsmith@example.edu.', 'jsmith@example.edu'],
    ['Call 608-555-1212.', '608-555-1212'],
    ['His SSN is 123-45-6789.', '123-45-6789'],
    ['The host was 10.14.22.9.', '10.14.22.9'],
    ['See https://example.edu/page.', 'https://example.edu/page'],
    ['Date of birth: 03/14/2003.', '03/14/2003'],
    ['They live at 4820 North Oakland Avenue.', '4820 North Oakland Avenue'],
  ];
  for (const [sentence, expected] of cases) {
    const found = findPatterns(sentence, { enabled: RECOGNIZER_IDS });
    assert.equal(found.length, 1, `expected exactly one detection in: ${sentence}`);
    assert.equal(found[0].matched, expected);
    // The character after the match must still be the sentence's period.
    assert.equal(sentence[found[0].end], '.', `punctuation was consumed in: ${sentence}`);
  }
});

test('dates count only with birth context', () => {
  assert.deepEqual(texts(findDatesOfBirth('Date of birth: 04/12/2001')), ['04/12/2001']);
  assert.deepEqual(texts(findDatesOfBirth('The essay is due 04/12/2001')), [], 'an ordinary date is not PII');
});

test('simple ID formats compile safely', () => {
  const re = compileIdFormat('W#######');
  assert.deepEqual(texts(findStudentIds('student W1234567 enrolled', re)), ['W1234567']);
  assert.deepEqual(texts(findStudentIds('student W123 enrolled', re)), []);
});

test('leading zeros in IDs are preserved', () => {
  const re = compileIdFormat('########');
  assert.deepEqual(texts(findStudentIds('id 00123456 here', re)), ['00123456']);
});

test('dangerous instructor-supplied regexes are refused', () => {
  assert.ok(looksUnsafeRegex('(a+)+$'));
  assert.ok(looksUnsafeRegex('(\\d*)*'));
  assert.ok(!looksUnsafeRegex('[A-Z]\\d{7}'));
  assert.throws(() => compileIdRegex('(a+)+$'), /nested repetition/);
  assert.ok(compileIdRegex('[A-Z]\\d{7}'));
});

test('findPatterns honours the enabled list', () => {
  const text = 'jsmith@example.edu and 608-555-1212';
  assert.equal(findPatterns(text, { enabled: ['EMAIL'] }).length, 1);
  assert.equal(findPatterns(text, { enabled: ['EMAIL', 'PHONE'] }).length, 2);
  assert.equal(findPatterns(text, { enabled: [] }).length, 0);
});

test('ordinary prose produces no detections', () => {
  const prose = `The argument in chapter three rests on an assumption the author never defends.
  Section 4.2 of the textbook covers this on page 118, and the 2019 study cited there
  reaches the opposite conclusion. I found the counterexample on page 12 persuasive.`;
  assert.deepEqual(findPatterns(prose), [], 'no false positives in normal academic writing');
});
