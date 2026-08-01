/**
 * Fixture builders for the end-to-end tests.
 *
 * Every name here is invented. Nothing in this repository, including test data, uses a
 * real student's information.
 */

import JSZip from 'jszip';

export const ROSTER = [
  'Jane Smith, 00123456, jsmith@example.edu',
  'Robert Jones, 00998877, rjones@example.edu',
  'José Muñoz, 00445566, jmunoz@example.edu',
].join('\n');

export const AMBIGUOUS_ROSTER = 'Jane Smith\nJane Jones';

export const ESSAY_MARKDOWN = `Jane Smith
CS 1430, Section 2
jsmith@example.edu | (608) 555-1212 | Student ID 00123456

Jane's essay argues that the assigned reading overstates its case. As Smith notes in
her earlier draft, the evidence in chapter three is thin. Robert Jones disagreed in
seminar, and José Muñoz raised a related objection.
`;

export const CLEAN_MARKDOWN = `An analysis of chapter three

The argument rests on an assumption the author never defends. Section 4.2 of the
textbook covers this on page 118, and the 2019 study cited there reaches the opposite
conclusion.
`;

/** A .docx with the given paragraphs and core.xml author metadata. */
export async function makeDocx({ paragraphs, author = 'Jane Smith', withComments = false }) {
  const zip = new JSZip();

  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${withComments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ''}
</Types>`);

  zip.folder('_rels').file('.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`);

  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  zip.folder('word').file('document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`);

  if (withComments) {
    zip.folder('word').file('comments.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="1" w:author="Robert Jones"><w:p><w:r><w:t>See me about this.</w:t></w:r></w:p></w:comment>
</w:comments>`);
  }

  zip.folder('docProps').file('core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>${escapeXml(author)}</dc:creator>
<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>
</cp:coreProperties>`);

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** A syntactically valid PDF with no text layer — stands in for a scan. */
export function makeImageOnlyPdf() {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 8>>stream\n        \nendstream endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Read a downloaded ZIP into { filename: text }. */
export async function readZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const out = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async('string');
  }
  return out;
}
