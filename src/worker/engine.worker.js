/**
 * The engine worker.
 *
 * Everything that reads untrusted document content runs here: DOCX unzipping and text
 * extraction, roster matching, the pattern recognizers, tokenization and ZIP building.
 *
 * The reason is not speed. A setTimeout cannot interrupt a synchronous regex, so a cancel
 * button on the main thread would be decorative if matching ran there — the UI would be
 * frozen alongside the work it was meant to stop. Only worker.terminate() can actually
 * end a runaway job, so the work has to be somewhere terminable.
 *
 * PDF extraction is the exception: pdf.js runs in its own worker already, and the host
 * sends its results in pre-extracted.
 */

// UMD bundles. In a module worker `self` is defined and `exports`/`define` are not, so
// both fall through to assigning onto the global object.
import '../../vendor/mammoth.browser.min.js';
import '../../vendor/jszip.min.js';

import { parseRoster } from '../engine/roster.js';
import { analyzeBatch, buildProtectedBatch } from '../engine/anonymize.js';
import { restore } from '../engine/restore.js';
import { compileIdFormat, compileIdRegex } from '../engine/patterns.js';
import { normalizeDocumentText } from '../engine/normalize.js';
import { extractDocx } from '../extract/docx.js';
import { extractPlainText } from '../extract/plain.js';

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  const progress = (message, fraction) => self.postMessage({ id, type: 'progress', message, fraction });

  try {
    let result;
    switch (type) {
      case 'analyze': result = await handleAnalyze(payload, progress); break;
      case 'build': result = handleBuild(payload); break;
      case 'restore': result = handleRestore(payload); break;
      case 'zip': result = await handleZip(payload, progress); break;
      default: throw new Error(`Unknown job "${type}".`);
    }
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
});

async function handleAnalyze({ items, rosterText, options }, progress) {
  const { entries: roster, warnings: rosterWarnings } = parseRoster(rosterText ?? '');

  const idRegex = buildIdRegex(options);
  const prepared = [];
  const rejected = [];

  for (const [index, item] of items.entries()) {
    progress(`Reading ${item.filename}`, index / Math.max(items.length, 1));

    let extracted;
    if (item.kind === 'docx') {
      extracted = await extractDocx(item.buffer);
    } else if (item.kind === 'markdown' || item.kind === 'text') {
      extracted = extractPlainText(item.buffer);
    } else if (item.kind === 'pre-extracted') {
      extracted = {
        text: item.text ?? '',
        metadataNames: item.metadataNames ?? [],
        warnings: item.warnings ?? [],
        blocking: item.blocking ?? [],
      };
    } else {
      extracted = { text: '', metadataNames: [], warnings: [], blocking: [`Unsupported file type for ${item.filename}.`] };
    }

    if (extracted.blocking.length > 0) {
      // A file we could not read completely never reaches the protect stage. Letting it
      // through would show "0 items found" for a document nobody has actually checked.
      rejected.push({ docId: item.docId, filename: item.filename, reasons: extracted.blocking });
      continue;
    }

    prepared.push({
      docId: item.docId,
      filename: item.filename,
      text: normalizeDocumentText(extracted.text),
      metadataNames: extracted.metadataNames,
      warnings: extracted.warnings,
    });
  }

  progress('Looking for personal information', 0.75);
  const analysis = analyzeBatch(prepared, roster, {
    enabled: options?.enabled,
    idRegex,
  });

  return {
    batchId: analysis.batchId,
    docs: analysis.docs,
    warnings: analysis.warnings,
    roster,
    rosterWarnings,
    rejected,
  };
}

function buildIdRegex(options) {
  if (options?.idFormat) return compileIdFormat(options.idFormat);
  if (options?.idRegexSource) return compileIdRegex(options.idRegexSource);
  return null;
}

function handleBuild(payload) {
  return buildProtectedBatch(payload);
}

function handleRestore({ map, inputs, lenient }) {
  return restore({ map, inputs, lenient });
}

async function handleZip({ entries }, progress) {
  const zip = new self.JSZip();
  for (const entry of entries) {
    zip.file(entry.name, entry.text);
  }
  return zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => progress('Building archive', meta.percent / 100),
  );
}
