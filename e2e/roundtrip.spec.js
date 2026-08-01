/**
 * The end-to-end path the tool actually exists for: protect a batch, pretend an AI
 * replied, restore the names.
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ROSTER, AMBIGUOUS_ROSTER, ESSAY_MARKDOWN, CLEAN_MARKDOWN, makeDocx, readZip } from './fixtures.js';

const mdFile = (name, content) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(content, 'utf8') });

async function downloadBuffer(page, action) {
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  return readFile(await download.path());
}

async function protectBatch(page, { roster = ROSTER, files, idFormat = '########' } = {}) {
  await page.goto('/protect.html');
  await page.fill('#roster-text', roster);
  if (idFormat) {
    await page.click('summary');
    await page.fill('#id-format', idFormat);
  }
  await page.setInputFiles('#file-input', files);
  await page.click('#analyze-btn');
  await expect(page.locator('#step-review')).toBeVisible();
}

test('a batch is protected, then the feedback is restored with real names', async ({ page }) => {
  await protectBatch(page, {
    files: [
      mdFile('Jane Smith - Essay 2.md', ESSAY_MARKDOWN),
      mdFile('Robert Jones - Essay 2.md', 'Robert Jones wrote this one. Reach him at rjones@example.edu.'),
      mdFile('Jose Munoz - Essay 2.md', 'José Muñoz submitted late. His ID is 00445566.'),
    ],
  });

  // Nothing identifying is on screen as a leftover, and every student was found.
  await expect(page.locator('#review-stats')).toContainText('3');
  await expect(page.locator('#export-gate-note')).toHaveText('');

  await page.click('#to-export-btn');
  const protectedZip = await downloadBuffer(page, () => page.click('#download-protected-btn'));
  const entries = await readZip(protectedZip);

  const documents = Object.entries(entries).filter(([name]) => name.endsWith('.md'));
  expect(documents).toHaveLength(3);

  for (const [name, text] of documents) {
    // Filenames are built only from tokens: the original stem carried the student's name.
    expect(name).toMatch(/^PP_[A-Z0-9]{8}_D\d{2}/);
    for (const secret of ['Jane', 'Smith', 'Robert', 'Jones', 'Muñoz', 'jsmith@', 'rjones@', '00445566', '555-1212']) {
      expect(text, `${name} still contains "${secret}"`).not.toContain(secret);
    }
    expect(text).toMatch(/## Document \[PP_[A-Z0-9]{8}_D\d{2}\]/);
  }
  expect(entries['SUGGESTED-PROMPT.txt']).toContain('Keep every token exactly as written');

  // Save the map unencrypted for this test; encryption gets its own test below.
  await page.uncheck('#encrypt-toggle');
  const mapBuffer = await downloadBuffer(page, () => page.click('#download-map-btn'));
  const map = JSON.parse(mapBuffer.toString('utf8'));
  expect(map.app).toBe('dia');
  expect(map.entities.some((e) => e.restoreAs === 'Jane Smith')).toBe(true);

  // Stand in for the AI: reply with one section per document, headings intact.
  const reply = documents
    .map(([, text]) => {
      const heading = /## Document (\[PP_[A-Z0-9]{8}_D\d{2}\])/.exec(text)[1];
      const student = /\[PP_[A-Z0-9]{8}_S\d{2}\]/.exec(text)?.[0] ?? '';
      return `## Document ${heading}\n\nGood work, ${student}. The thesis is clear and the evidence supports it.\n`;
    })
    .join('\n');

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', {
    name: 'reidentification-map.json', mimeType: 'application/json', buffer: mapBuffer,
  });
  await expect(page.locator('#map-status')).toContainText('not encrypted');

  await page.fill('#feedback-text', reply);
  await page.click('#restore-btn');
  await expect(page.locator('#step-result')).toBeVisible();

  await expect(page.locator('#result-stats')).toContainText('3 of 3');
  await expect(page.locator('#result-messages')).not.toContainText('different batch');

  const restoredZip = await downloadBuffer(page, () => page.click('#download-restored-btn'));
  const restored = await readZip(restoredZip);

  const allText = Object.values(restored).join('\n');
  expect(allText).toContain('Jane Smith');
  expect(allText).toContain('Robert Jones');
  expect(allText).toContain('José Muñoz');
  // Filenames come back from the originals, which the instructor is entitled to see.
  expect(Object.keys(restored)).toContain('Jane Smith - Essay 2 - feedback.md');
  // And no token survived into the feedback the students would read.
  expect(allText).not.toMatch(/\[PP_[A-Z0-9]{8}_S\d{2}\]/);
});

test('the map can be encrypted and reopened, and a wrong passphrase fails safely', async ({ page }) => {
  await protectBatch(page, { files: [mdFile('Jane Smith - Essay.md', ESSAY_MARKDOWN)] });
  await page.click('#to-export-btn');
  await downloadBuffer(page, () => page.click('#download-protected-btn'));

  await page.fill('#passphrase', 'a good passphrase');
  await page.fill('#passphrase2', 'a good passphrase');
  const encrypted = await downloadBuffer(page, () => page.click('#download-map-btn'));

  const envelope = JSON.parse(encrypted.toString('utf8'));
  expect(envelope.encrypted).toBe(true);
  expect(envelope.cipher).toBe('AES-256-GCM');
  expect(envelope.iterations).toBe(600000);
  expect(encrypted.toString('utf8')).not.toContain('Jane Smith');

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', {
    name: 'reidentification-map.json.enc', mimeType: 'application/json', buffer: encrypted,
  });
  await expect(page.locator('#passphrase-prompt')).toBeVisible();

  await page.fill('#map-passphrase', 'the wrong one');
  await page.click('#unlock-btn');
  await expect(page.locator('#map-status')).toContainText('passphrase may be wrong');
  await expect(page.locator('#restore-btn')).toBeDisabled();

  await page.fill('#map-passphrase', 'a good passphrase');
  await page.click('#unlock-btn');
  await expect(page.locator('#map-status')).toContainText('Map unlocked');
  await expect(page.locator('#restore-btn')).toBeDisabled(); // still needs feedback
});

test('the passphrase mismatch is caught before anything is written', async ({ page }) => {
  await protectBatch(page, { files: [mdFile('Jane Smith - Essay.md', ESSAY_MARKDOWN)] });
  await page.click('#to-export-btn');
  await downloadBuffer(page, () => page.click('#download-protected-btn'));

  await page.fill('#passphrase', 'one passphrase');
  await page.fill('#passphrase2', 'a different one');
  await page.click('#download-map-btn');
  await expect(page.locator('#export-messages')).toContainText('do not match');
});

test('export is blocked until an ambiguous name is resolved', async ({ page }) => {
  await protectBatch(page, {
    roster: AMBIGUOUS_ROSTER,
    idFormat: '',
    files: [mdFile('essay.md', 'Jane submitted the paper on time.')],
  });

  await expect(page.locator('#decisions-panel')).toBeVisible();
  await expect(page.locator('#to-export-btn')).toBeDisabled();
  await expect(page.locator('#export-gate-note')).toContainText('need a decision');

  await page.click('#redact-all-btn');
  await expect(page.locator('#to-export-btn')).toBeEnabled();

  await page.click('#to-export-btn');
  const zip = await readZip(await downloadBuffer(page, () => page.click('#download-protected-btn')));
  const text = Object.entries(zip).find(([n]) => n.endsWith('.md'))[1];
  expect(text).not.toContain('Jane');
});

test('an ambiguous name can be assigned to one student', async ({ page }) => {
  await protectBatch(page, {
    roster: AMBIGUOUS_ROSTER,
    idFormat: '',
    files: [mdFile('essay.md', 'Jane submitted the paper on time.')],
  });

  await page.selectOption('#decisions-list select', { label: 'This is Jane Smith' });
  await expect(page.locator('#to-export-btn')).toBeEnabled();

  await page.click('#to-export-btn');
  await downloadBuffer(page, () => page.click('#download-protected-btn'));
  await page.uncheck('#encrypt-toggle');
  const mapBuffer = await downloadBuffer(page, () => page.click('#download-map-btn'));
  const map = JSON.parse(mapBuffer.toString('utf8'));

  expect(map.entities.find((e) => e.type === 'PERSON').restoreAs).toBe('Jane Smith');
});

test('feedback restored with the wrong map is reported, not silently mangled', async ({ page }) => {
  await protectBatch(page, { files: [mdFile('Jane Smith - Essay.md', ESSAY_MARKDOWN)] });
  await page.click('#to-export-btn');
  await downloadBuffer(page, () => page.click('#download-protected-btn'));
  await page.uncheck('#encrypt-toggle');
  const mapBuffer = await downloadBuffer(page, () => page.click('#download-map-btn'));

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', {
    name: 'map.json', mimeType: 'application/json', buffer: mapBuffer,
  });
  await page.fill('#feedback-text', 'Nice work [PP_ZZZZ9999_S01], your argument in [PP_ZZZZ9999_S02] was clear.');
  await page.click('#restore-btn');

  await expect(page.locator('#result-messages')).toContainText('different batch');
  await expect(page.locator('#result-preview')).toContainText('[PP_ZZZZ9999_S01]');
});

test('a token the AI reformatted is reported, and repaired only on request', async ({ page }) => {
  await protectBatch(page, { files: [mdFile('Jane Smith - Essay.md', ESSAY_MARKDOWN)] });
  await page.click('#to-export-btn');
  const zip = await readZip(await downloadBuffer(page, () => page.click('#download-protected-btn')));
  await page.uncheck('#encrypt-toggle');
  const mapBuffer = await downloadBuffer(page, () => page.click('#download-map-btn'));

  const doc = Object.entries(zip).find(([n]) => n.endsWith('.md'))[1];
  const studentToken = /\[PP_[A-Z0-9]{8}_S\d{2}\]/.exec(doc)[0];

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', { name: 'map.json', mimeType: 'application/json', buffer: mapBuffer });
  await page.fill('#feedback-text', `Well argued, ${studentToken.toLowerCase()}.`);
  await page.click('#restore-btn');

  await expect(page.locator('#result-messages')).toContainText('reformatted');
  await expect(page.locator('#result-preview')).not.toContainText('Jane Smith');

  await page.check('#lenient-toggle');
  await page.click('#restore-btn');
  await expect(page.locator('#result-preview')).toContainText('Jane Smith');
});

test('a reply with no document headings is not split apart', async ({ page }) => {
  await protectBatch(page, {
    files: [
      mdFile('Jane Smith - Essay.md', 'Jane Smith wrote this.'),
      mdFile('Robert Jones - Essay.md', 'Robert Jones wrote this.'),
    ],
  });
  await page.click('#to-export-btn');
  await downloadBuffer(page, () => page.click('#download-protected-btn'));
  await page.uncheck('#encrypt-toggle');
  const mapBuffer = await downloadBuffer(page, () => page.click('#download-map-btn'));

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', { name: 'map.json', mimeType: 'application/json', buffer: mapBuffer });
  await page.fill('#feedback-text', 'Everyone did fine this week. No individual notes.');
  await page.click('#restore-btn');

  await expect(page.locator('#result-stats')).toContainText('0 of 2');
  await expect(page.locator('#result-messages')).toContainText('No feedback was found');
  expect(await page.locator('#result-tabs button').count()).toBe(1);
});

test('a passage the instructor selects by hand is redacted', async ({ page }) => {
  await protectBatch(page, {
    idFormat: '',
    files: [mdFile('essay.md', 'Jane Smith is the only student from Iceland in the program.')],
  });

  // Select "the only student from Iceland" inside the preview.
  await page.evaluate(() => {
    const preview = document.querySelector('#preview');
    const phrase = 'the only student from Iceland';
    for (const node of preview.querySelectorAll('span')) {
      const index = node.textContent.indexOf(phrase);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node.firstChild, index);
      range.setEnd(node.firstChild, index + phrase.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    throw new Error('phrase not found in preview');
  });

  await page.click('#redact-selection-btn');
  await expect(page.locator('#preview mark.is-manual')).toHaveCount(1);

  await page.click('#to-export-btn');
  const zip = await readZip(await downloadBuffer(page, () => page.click('#download-protected-btn')));
  const text = Object.entries(zip).find(([n]) => n.endsWith('.md'))[1];
  expect(text).not.toContain('Iceland');
  expect(text).not.toContain('Jane Smith');
});

test('Word documents are read, and their hidden parts are flagged', async ({ page }) => {
  const docx = await makeDocx({
    paragraphs: ['Jane Smith', 'CS 1430', "Jane's argument about Smith is well supported."],
    withComments: true,
  });

  await protectBatch(page, {
    idFormat: '',
    files: [{ name: 'Jane Smith - Paper.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx }],
  });

  await expect(page.locator('#review-messages')).toContainText('comments');
  await page.click('#to-export-btn');
  const zip = await readZip(await downloadBuffer(page, () => page.click('#download-protected-btn')));
  const text = Object.entries(zip).find(([n]) => n.endsWith('.md'))[1];
  expect(text).not.toContain('Jane');
  expect(text).not.toContain('Smith');
});

test('a document with nothing to find says so rather than looking finished', async ({ page }) => {
  await protectBatch(page, { idFormat: '', files: [mdFile('clean.md', CLEAN_MARKDOWN)] });
  await expect(page.locator('#detections-list')).toContainText('check the text yourself');
});
