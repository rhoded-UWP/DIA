/**
 * Resource caps. Checked before work starts so a hostile or merely enormous file is
 * refused rather than freezing the tab. The engine worker enforces deadlines on top of
 * these — see worker/engineHost.js.
 */

export const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxBatchFiles: 40,
  maxBatchBytes: 200 * 1024 * 1024,
  maxPdfPages: 150,
  maxZipEntries: 2000,
  maxZipUncompressedBytes: 100 * 1024 * 1024,
  maxZipCompressionRatio: 200,
  maxExtractedChars: 2_000_000,
  maxRosterEntries: 500,
  maxEntities: 5000,
  maxMapBytes: 20 * 1024 * 1024,
  maxFilenameLength: 120,
  maxFieldLength: 500,
  // Per-file wall clock before the worker is terminated.
  perFileTimeoutMs: 30_000,
  // PDFs with less text than this per page are treated as image-based, not as clean.
  minCharsPerPdfPage: 25,
};

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** @returns {string[]} human-readable reasons the batch cannot be processed. */
export function checkBatch(files) {
  const problems = [];
  if (files.length === 0) problems.push('No files selected.');
  if (files.length > LIMITS.maxBatchFiles) {
    problems.push(`Too many files: ${files.length}. The limit is ${LIMITS.maxBatchFiles} per batch.`);
  }
  let total = 0;
  for (const f of files) {
    total += f.size;
    if (f.size > LIMITS.maxFileBytes) {
      problems.push(`"${f.name}" is ${formatBytes(f.size)}. The per-file limit is ${formatBytes(LIMITS.maxFileBytes)}.`);
    }
  }
  if (total > LIMITS.maxBatchBytes) {
    problems.push(`Batch is ${formatBytes(total)}. The limit is ${formatBytes(LIMITS.maxBatchBytes)}.`);
  }
  return problems;
}
