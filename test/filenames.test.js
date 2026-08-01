import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename, replaceExtension, makeUniqueNamer } from '../src/engine/filenames.js';
import { LIMITS } from '../src/engine/limits.js';

test('path components are stripped', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\me\\essay.docx'), 'essay.docx');
  assert.equal(sanitizeFilename('folder/sub/essay.docx'), 'essay.docx');
});

test('traversal segments never survive', () => {
  for (const evil of ['..', '.', '../', '..\\', './..']) {
    const safe = sanitizeFilename(evil);
    assert.ok(safe !== '.' && safe !== '..' && safe !== '', `"${evil}" produced "${safe}"`);
    assert.ok(!safe.includes('/') && !safe.includes('\\'));
  }
});

test('illegal and control characters are replaced', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h.md'), 'a_b_c_d_e_f_g_h.md');
  assert.ok(!sanitizeFilename('bad\u0000name.md').includes('\u0000'));
});

test('Windows reserved names are made safe', () => {
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('nul.md'), '_nul.md');
  assert.equal(sanitizeFilename('COM1.txt'), '_COM1.txt');
});

test('trailing dots and spaces are trimmed', () => {
  assert.equal(sanitizeFilename('essay.md. '), 'essay.md');
  assert.equal(sanitizeFilename('  essay.md'), 'essay.md');
});

test('overlong names are truncated but keep their extension', () => {
  const long = 'a'.repeat(500) + '.md';
  const safe = sanitizeFilename(long);
  assert.ok(safe.length <= LIMITS.maxFilenameLength);
  assert.ok(safe.endsWith('.md'));
});

test('non-string input falls back', () => {
  assert.equal(sanitizeFilename(undefined), 'document');
  assert.equal(sanitizeFilename(null), 'document');
});

test('replaceExtension handles names with and without dots', () => {
  assert.equal(replaceExtension('essay.docx', '.md'), 'essay.md');
  assert.equal(replaceExtension('essay', '.md'), 'essay.md');
  assert.equal(replaceExtension('my.essay.docx', ''), 'my.essay');
});

test('duplicate names are made unique within one archive', () => {
  const unique = makeUniqueNamer();
  assert.equal(unique('paper.md'), 'paper.md');
  assert.equal(unique('paper.md'), 'paper (2).md');
  assert.equal(unique('PAPER.md'), 'PAPER (3).md', 'case-insensitive filesystems would collide');
});

test('names that collide only after sanitizing are still separated', () => {
  const unique = makeUniqueNamer();
  assert.equal(unique('a<b.md'), 'a_b.md');
  assert.equal(unique('a>b.md'), 'a_b (2).md');
});
