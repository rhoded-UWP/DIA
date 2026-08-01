/**
 * Capture screenshots of the main screens for documentation.
 *   node tools/serve.js &   then   node tools/screenshots.js
 */

import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = process.env.OUT ?? '.tmp/screens';

const ROSTER = [
  'Jane Smith, 00123456, jsmith@example.edu',
  'Robert Jones, 00998877, rjones@example.edu',
  'José Muñoz, 00445566, jmunoz@example.edu',
].join('\n');

const ESSAY = `Jane Smith
CS 1430, Section 2
jsmith@example.edu | (608) 555-1212 | Student ID 00123456

Jane's essay argues that the assigned reading overstates its case. As Smith notes in her
earlier draft, the evidence in chapter three is thin. Robert Jones disagreed in seminar,
and José Muñoz raised a related objection. I am the only student from Iceland in the
program, which shaped how I read the chapter.
`;

await mkdir(OUT, { recursive: true });

for (const scheme of ['dark', 'light']) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, colorScheme: scheme });

  await page.goto(`${BASE}/index.html`);
  await page.screenshot({ path: `${OUT}/01-home-${scheme}.png`, fullPage: true });

  await page.goto(`${BASE}/protect.html`);
  await page.fill('#roster-text', ROSTER);
  await page.setInputFiles('#file-input', [
    { name: 'Jane Smith - Essay 2.md', mimeType: 'text/markdown', buffer: Buffer.from(ESSAY, 'utf8') },
    { name: 'Robert Jones - Essay 2.md', mimeType: 'text/markdown', buffer: Buffer.from('Robert Jones wrote this one. Reach him at rjones@example.edu or 608-555-9090.', 'utf8') },
    { name: 'Jose Munoz - Essay 2.md', mimeType: 'text/markdown', buffer: Buffer.from('José Muñoz submitted late. Student ID 00445566.', 'utf8') },
  ]);
  await page.click('summary');
  await page.fill('#id-format', '########');
  await page.click('#analyze-btn');
  await page.waitForSelector('#step-review:not([hidden])');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/02-review-${scheme}.png`, fullPage: true });

  await page.click('#to-export-btn');
  await page.waitForTimeout(300);
  await page.locator('#step-export').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-export-${scheme}.png`, fullPage: true });

  await page.goto(`${BASE}/restore.html`);
  await page.screenshot({ path: `${OUT}/04-restore-${scheme}.png`, fullPage: true });

  await browser.close();
  console.log(`captured ${scheme}`);
}
