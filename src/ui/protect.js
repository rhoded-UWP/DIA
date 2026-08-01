/**
 * The protect flow.
 *
 * This module is presentation and orchestration only. Detection, tokenization and archive
 * building all happen in the engine worker; PDF text extraction happens through pdf.js,
 * which runs its own worker. Nothing here inspects document content itself.
 *
 * Two rules shape the interaction design:
 *
 *   Export is blocked while any ambiguous name is unresolved. An unresolved ambiguity is
 *   a real name still sitting in the text, so "I'll deal with it later" cannot be a path
 *   that leads to a download.
 *
 *   The protected archive and the map are separate, deliberate downloads. Browsers block
 *   two automatic downloads from one gesture anyway, and the second click is a second
 *   chance to say that this file must not be uploaded.
 */

import { $, el, clear, show, note, pill, downloadBlob, downloadText, wireDropzone, markCurrentNav, excerpt } from './dom.js';
import { engine } from '../worker/engineHost.js';
import { extractPdf } from '../extract/pdf.js';
import { kindForFilename, unsupportedMessage } from '../extract/plain.js';
import { RECOGNIZERS } from '../engine/patterns.js';
import { unresolvedDecisions } from '../engine/anonymize.js';
import { LIMITS, checkBatch, formatBytes } from '../engine/limits.js';
import { encryptMapVerified } from '../engine/crypto.js';

markCurrentNav();

const state = {
  files: [],
  analysis: null,
  decisions: {},
  manual: [],
  activeDocId: null,
  built: null,
  protectedDownloaded: false,
  busy: false,
};

let nextFileId = 1;

/* ------------------------------------------------------------------ setup --- */

const els = {
  rosterText: $('#roster-text'),
  rosterFile: $('#roster-file'),
  rosterFileBtn: $('#roster-file-btn'),
  rosterSummary: $('#roster-summary'),
  rosterWarnings: $('#roster-warnings'),
  idFormat: $('#id-format'),
  toggles: $('#recognizer-toggles'),
  dropzone: $('#dropzone'),
  fileInput: $('#file-input'),
  filelist: $('#filelist'),
  fileProblems: $('#file-problems'),
  analyzeBtn: $('#analyze-btn'),
  cancelBtn: $('#cancel-btn'),
  clearFilesBtn: $('#clear-files-btn'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  progressLabel: $('#progress-label'),
  stepFiles: $('#step-files'),
  stepReview: $('#step-review'),
  stepExport: $('#step-export'),
  reviewStats: $('#review-stats'),
  reviewMessages: $('#review-messages'),
  doctabs: $('#doctabs'),
  preview: $('#preview'),
  previewNote: $('#preview-note'),
  decisionsPanel: $('#decisions-panel'),
  decisionsIntro: $('#decisions-intro'),
  decisionsList: $('#decisions-list'),
  detectionsList: $('#detections-list'),
  redactSelectionBtn: $('#redact-selection-btn'),
  redactAllBtn: $('#redact-all-btn'),
  toExportBtn: $('#to-export-btn'),
  exportGateNote: $('#export-gate-note'),
  downloadProtectedBtn: $('#download-protected-btn'),
  protectedStatus: $('#protected-status'),
  exportB: $('#export-b'),
  encryptToggle: $('#encrypt-toggle'),
  passphraseFields: $('#passphrase-fields'),
  passphrase: $('#passphrase'),
  passphrase2: $('#passphrase2'),
  downloadMapBtn: $('#download-map-btn'),
  mapStatus: $('#map-status'),
  exportMessages: $('#export-messages'),
  backToReviewBtn: $('#back-to-review-btn'),
  startOverBtn: $('#start-over-btn'),
};

for (const recognizer of RECOGNIZERS) {
  const id = `rec-${recognizer.id}`;
  els.toggles.appendChild(el('div', { class: 'checkline' },
    el('input', { type: 'checkbox', id, checked: recognizer.default, dataset: { recognizer: recognizer.id } }),
    el('label', { for: id, text: recognizer.label }),
  ));
}

function enabledRecognizers() {
  return [...els.toggles.querySelectorAll('input:checked')].map((input) => input.dataset.recognizer);
}

/* ------------------------------------------------------------------ roster --- */

els.rosterFileBtn.addEventListener('click', () => els.rosterFile.click());
els.rosterFile.addEventListener('change', async () => {
  const file = els.rosterFile.files[0];
  if (!file) return;
  els.rosterText.value = await file.text();
  els.rosterFile.value = '';
  updateReadiness();
});
els.rosterText.addEventListener('input', updateReadiness);

/* ------------------------------------------------------------------- files --- */

wireDropzone(els.dropzone, els.fileInput, addFiles);
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});

function addFiles(incoming) {
  const problems = [];
  for (const file of incoming) {
    const kind = kindForFilename(file.name);
    if (kind === 'unsupported' || kind === 'legacy-doc') {
      problems.push(unsupportedMessage(kind, file.name));
      continue;
    }
    if (state.files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
    state.files.push({ id: `d${String(nextFileId++).padStart(2, '0')}`, file, kind });
  }

  problems.push(...checkBatch(state.files.map((f) => f.file)).filter((p) => !p.startsWith('No files')));

  clear(els.fileProblems);
  if (problems.length) els.fileProblems.appendChild(note('danger', 'Some files were not added', problems));

  renderFileList();
  updateReadiness();
}

function renderFileList() {
  clear(els.filelist);
  for (const entry of state.files) {
    els.filelist.appendChild(el('li', {},
      el('span', { class: 'filelist__name', text: entry.file.name }),
      el('span', { class: 'filelist__meta', text: `${entry.kind} · ${formatBytes(entry.file.size)}` }),
      el('button', {
        class: 'btn-sm', type: 'button',
        'aria-label': `Remove ${entry.file.name}`,
        onclick: () => {
          state.files = state.files.filter((f) => f.id !== entry.id);
          renderFileList();
          updateReadiness();
        },
      }, 'Remove'),
    ));
  }
  show(els.clearFilesBtn, state.files.length > 0);
}

els.clearFilesBtn.addEventListener('click', () => {
  state.files = [];
  clear(els.fileProblems);
  renderFileList();
  updateReadiness();
});

function updateReadiness() {
  const hasRoster = els.rosterText.value.trim().length > 0;
  const hasFiles = state.files.length > 0;
  els.analyzeBtn.disabled = state.busy || !hasFiles;

  els.rosterSummary.textContent = hasRoster
    ? `${els.rosterText.value.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length} line(s) entered`
    : '';

  if (hasFiles && !hasRoster) {
    els.analyzeBtn.textContent = 'Find personal information (no roster given)';
  } else {
    els.analyzeBtn.textContent = 'Find personal information';
  }
}

/* ---------------------------------------------------------------- analysis --- */

els.analyzeBtn.addEventListener('click', analyze);
els.cancelBtn.addEventListener('click', () => {
  engine.cancel();
  setBusy(false);
  setProgress('Cancelled.', 0);
});

function setBusy(busy) {
  state.busy = busy;
  els.analyzeBtn.disabled = busy || state.files.length === 0;
  show(els.cancelBtn, busy);
  show(els.progress, busy);
}

function setProgress(message, fraction) {
  els.progressLabel.textContent = message;
  els.progressFill.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

async function analyze() {
  setBusy(true);
  setProgress('Reading files…', 0.02);
  clear(els.reviewMessages);

  try {
    const items = [];
    for (const [index, entry] of state.files.entries()) {
      setProgress(`Reading ${entry.file.name}`, 0.05 + (index / state.files.length) * 0.45);
      const buffer = await entry.file.arrayBuffer();

      if (entry.kind === 'pdf') {
        // pdf.js has to run here: it spawns its own worker, and nesting that inside the
        // engine worker buys nothing.
        const extracted = await extractPdf(buffer);
        items.push({
          docId: entry.id, filename: entry.file.name, kind: 'pre-extracted',
          text: extracted.text, metadataNames: extracted.metadataNames,
          warnings: extracted.warnings, blocking: extracted.blocking,
        });
      } else {
        items.push({ docId: entry.id, filename: entry.file.name, kind: entry.kind, buffer });
      }
    }

    setProgress('Looking for personal information…', 0.6);
    const analysis = await engine.run('analyze', {
      items,
      rosterText: els.rosterText.value,
      options: { enabled: enabledRecognizers(), idFormat: els.idFormat.value.trim() },
    }, {
      onProgress: ({ message, fraction }) => setProgress(message, 0.6 + (fraction ?? 0) * 0.35),
      timeoutMs: Math.max(LIMITS.perFileTimeoutMs, state.files.length * LIMITS.perFileTimeoutMs),
      transfer: items.filter((i) => i.buffer).map((i) => i.buffer),
    });

    state.analysis = analysis;
    state.decisions = {};
    state.manual = [];
    state.built = null;
    state.protectedDownloaded = false;
    state.activeDocId = analysis.docs[0]?.docId ?? null;

    setProgress('Done.', 1);
    renderReview();
  } catch (err) {
    clear(els.reviewMessages);
    els.fileProblems.appendChild(note('danger', 'Processing stopped', [err.message]));
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ review --- */

function renderReview() {
  const { docs, rejected, roster, rosterWarnings, warnings } = state.analysis;

  clear(els.rosterWarnings);
  if (rosterWarnings.length) els.rosterWarnings.appendChild(note('warn', 'About your roster', rosterWarnings));
  els.rosterSummary.textContent = `${roster.length} student(s) on the roster`;

  clear(els.reviewMessages);
  if (rejected.length) {
    els.reviewMessages.appendChild(note(
      'danger',
      `${rejected.length} file(s) could not be checked and were left out`,
      rejected.map((r) => `${r.filename}: ${r.reasons.join(' ')}`),
    ));
  }
  for (const warning of warnings) {
    els.reviewMessages.appendChild(note('warn', '', [warning]));
  }
  if (roster.length === 0) {
    els.reviewMessages.appendChild(note('warn', 'No roster was provided', [
      'Only pattern matches such as email addresses were looked for. Student names will not have been found. Go back to step 1 and add your class list.',
    ]));
  }

  const docWarnings = docs.flatMap((d) => d.warnings.map((w) => `${d.filename}: ${w}`));
  if (docWarnings.length) {
    els.reviewMessages.appendChild(note('warn', 'Parts of some documents could not be checked', docWarnings));
  }

  show(els.stepReview, docs.length > 0);
  show(els.stepExport, false);
  if (docs.length === 0) {
    els.reviewMessages.appendChild(note('danger', 'Nothing to review', ['None of the files could be read.']));
    return;
  }

  renderStats();
  renderDocTabs();
  renderActiveDoc();
  els.stepReview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStats() {
  const { docs } = state.analysis;
  const all = docs.flatMap((d) => d.detections);
  const open = unresolvedDecisions(docs, state.decisions).length;

  clear(els.reviewStats);
  const stats = [
    ['Documents', docs.length, false],
    ['Items found', all.length + state.manual.length, false],
    ['Student names', all.filter((d) => d.type === 'PERSON').length, false],
    ['Need a decision', open, open > 0],
  ];
  for (const [label, value, alert] of stats) {
    els.reviewStats.appendChild(el('div', { class: `stat${alert ? ' stat--alert' : ''}` },
      el('div', { class: 'stat__value', text: String(value) }),
      el('div', { class: 'stat__label', text: label }),
    ));
  }
}

function renderDocTabs() {
  clear(els.doctabs);
  for (const doc of state.analysis.docs) {
    const open = unresolvedDecisions([doc], state.decisions).length;
    const tab = el('button', {
      type: 'button', class: 'doctab', role: 'tab',
      'aria-selected': String(doc.docId === state.activeDocId),
      onclick: () => { state.activeDocId = doc.docId; renderDocTabs(); renderActiveDoc(); },
    }, doc.filename);
    if (open > 0) tab.appendChild(el('span', { class: 'dot', text: ' ●', title: `${open} need a decision` }));
    els.doctabs.appendChild(tab);
  }
}

function activeDoc() {
  return state.analysis.docs.find((d) => d.docId === state.activeDocId);
}

/** All items for a document: automatic detections plus the instructor's own selections. */
function itemsFor(doc) {
  const manual = state.manual
    .filter((m) => m.docId === doc.docId)
    .map((m) => ({
      ...m,
      id: `${m.docId}:${m.start}:${m.end}`,
      type: 'MANUAL', kind: 'manual', needsDecision: false,
      matched: doc.text.slice(m.start, m.end),
    }));
  return [...doc.detections, ...manual].sort((a, b) => a.start - b.start);
}

function classFor(item) {
  if (state.decisions[item.id]?.action === 'ignore') return 'is-off';
  if (item.needsDecision && !state.decisions[item.id]) return 'is-decision';
  if (item.type === 'MANUAL') return 'is-manual';
  if (item.type === 'PERSON') return 'is-person';
  return '';
}

/**
 * Render the document as text nodes and <mark> elements. Offsets are carried in
 * data-start so a selection in the preview can be mapped back to the source text.
 */
function renderActiveDoc() {
  const doc = activeDoc();
  if (!doc) return;

  const items = itemsFor(doc);
  clear(els.preview);

  let cursor = 0;
  for (const item of items) {
    if (item.start < cursor) continue; // overlapping manual selection; skip the later one
    if (item.start > cursor) {
      els.preview.appendChild(el('span', { dataset: { start: String(cursor) } }, doc.text.slice(cursor, item.start)));
    }
    const mark = el('mark', {
      class: classFor(item),
      dataset: { start: String(item.start), id: item.id },
      title: describe(item),
      tabindex: '0',
      onclick: () => focusDetection(item.id),
    }, item.matched);
    els.preview.appendChild(mark);
    cursor = item.end;
  }
  if (cursor < doc.text.length) {
    els.preview.appendChild(el('span', { dataset: { start: String(cursor) } }, doc.text.slice(cursor)));
  }

  els.previewNote.textContent = doc.filename.toLowerCase().endsWith('.pdf')
    ? 'This is the text that will be exported, not a picture of the page. PDF text can come out in a different order than it appears on screen.'
    : 'This is the text that will be exported.';

  renderDecisions(doc);
  renderDetections(doc);
  renderStats();
  updateExportGate();
}

function describe(item) {
  if (item.type === 'MANUAL') return 'Redacted by you';
  if (item.needsDecision) return 'Needs your decision';
  if (item.type === 'PERSON') return 'Student name';
  return `Pattern match: ${item.type.toLowerCase().replace(/_/g, ' ')}`;
}

function renderDecisions(doc) {
  const open = doc.detections.filter((d) => d.needsDecision);
  show(els.decisionsPanel, open.length > 0);
  if (open.length === 0) return;

  els.decisionsIntro.textContent =
    'These matched more than one student, or matched only initials. Assign each one, or redact it without naming anybody.';

  clear(els.decisionsList);
  for (const item of open) {
    const decision = state.decisions[item.id];
    const row = el('div', { class: `detection${decision ? ' detection--resolved' : ''}` });

    row.appendChild(el('div', { class: 'detection__head' },
      el('span', { class: 'detection__value', text: excerpt(item.matched, 40) }),
      pill('decision', item.kind === 'roster-initial' ? 'initials' : 'ambiguous'),
    ));

    const candidates = (item.rosterKeys ?? []).map((key) => state.analysis.roster.find((r) => r.key === key)).filter(Boolean);
    const select = el('select', {
      'aria-label': `Assign ${excerpt(item.matched, 30)}`,
      onchange: (event) => {
        const value = event.target.value;
        if (value === '') delete state.decisions[item.id];
        else if (value === '__redact') state.decisions[item.id] = { action: 'redact' };
        else if (value === '__ignore') state.decisions[item.id] = { action: 'ignore' };
        else state.decisions[item.id] = { action: 'assign', rosterKey: value };
        renderActiveDoc();
        renderDocTabs();
      },
    },
      el('option', { value: '', text: 'Choose…' }),
      candidates.map((c) => el('option', {
        value: c.key,
        selected: decision?.action === 'assign' && decision.rosterKey === c.key,
        text: `This is ${c.fullName}`,
      })),
      el('option', { value: '__redact', selected: decision?.action === 'redact', text: 'Redact without naming' }),
      el('option', { value: '__ignore', selected: decision?.action === 'ignore', text: 'Not a student — leave it' }),
    );

    row.appendChild(el('div', { class: 'detection__controls' }, select));
    els.decisionsList.appendChild(row);
  }
}

els.redactAllBtn.addEventListener('click', () => {
  for (const doc of state.analysis.docs) {
    for (const item of doc.detections) {
      if (item.needsDecision && !state.decisions[item.id]) state.decisions[item.id] = { action: 'redact' };
    }
  }
  renderActiveDoc();
  renderDocTabs();
});

function renderDetections(doc) {
  clear(els.detectionsList);
  const items = itemsFor(doc);
  if (items.length === 0) {
    els.detectionsList.appendChild(el('p', { class: 'faint', text: 'Nothing was found in this document. That may be correct, or it may mean the roster is missing names — check the text yourself.' }));
    return;
  }

  for (const item of items) {
    const ignored = state.decisions[item.id]?.action === 'ignore';
    const row = el('div', { class: 'detection' });
    row.appendChild(el('div', { class: 'detection__head' },
      el('span', { class: 'detection__value', text: excerpt(item.matched, 34) }),
      pill(item.type === 'PERSON' ? 'person' : item.type === 'MANUAL' ? 'manual' : 'pattern',
        item.type === 'MANUAL' ? 'yours' : item.type.toLowerCase().replace(/_/g, ' ')),
    ));

    const controls = el('div', { class: 'detection__controls' });
    if (item.type === 'MANUAL' && item.kind === 'manual') {
      controls.appendChild(el('button', {
        type: 'button', class: 'btn-sm',
        onclick: () => {
          state.manual = state.manual.filter((m) => !(m.docId === item.docId && m.start === item.start && m.end === item.end));
          renderActiveDoc();
        },
      }, 'Undo'));
    } else if (!item.needsDecision) {
      controls.appendChild(el('button', {
        type: 'button', class: 'btn-sm',
        onclick: () => {
          if (ignored) delete state.decisions[item.id];
          else state.decisions[item.id] = { action: 'ignore' };
          renderActiveDoc();
        },
      }, ignored ? 'Redact after all' : 'Leave this one'));
    }
    controls.appendChild(el('button', {
      type: 'button', class: 'btn-sm',
      onclick: () => focusDetection(item.id),
    }, 'Show'));
    row.appendChild(controls);
    els.detectionsList.appendChild(row);
  }
}

function focusDetection(id) {
  for (const mark of els.preview.querySelectorAll('mark')) {
    mark.classList.toggle('is-focus', mark.dataset.id === id);
  }
  const target = els.preview.querySelector(`mark[data-id="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* -------------------------------------------------------- manual redaction --- */

document.addEventListener('selectionchange', () => {
  els.redactSelectionBtn.disabled = selectionRange() === null;
});

/** Map the current selection back to offsets in the source text. */
function selectionRange() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!els.preview.contains(range.commonAncestorContainer)) return null;

  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function offsetOf(node, offsetInNode) {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const base = element?.dataset?.start;
  if (base === undefined) return null;
  return Number(base) + offsetInNode;
}

els.redactSelectionBtn.addEventListener('click', () => {
  const range = selectionRange();
  const doc = activeDoc();
  if (!range || !doc) return;

  const overlapping = itemsFor(doc).some((item) => range.start < item.end && item.start < range.end);
  if (overlapping) {
    clear(els.reviewMessages);
    els.reviewMessages.appendChild(note('warn', 'That selection overlaps something already marked', [
      'Undo the existing item first, or select a passage that does not overlap it.',
    ]));
    return;
  }

  state.manual.push({ docId: doc.docId, start: range.start, end: range.end });
  window.getSelection()?.removeAllRanges();
  renderActiveDoc();
});

/* ------------------------------------------------------------------ export --- */

function updateExportGate() {
  const open = unresolvedDecisions(state.analysis.docs, state.decisions);
  els.toExportBtn.disabled = open.length > 0;
  els.exportGateNote.textContent = open.length > 0
    ? `${open.length} item(s) still need a decision. Until they are resolved those names stay in the text.`
    : '';
}

els.toExportBtn.addEventListener('click', () => {
  show(els.stepExport, true);
  state.built = null;
  state.protectedDownloaded = false;
  els.protectedStatus.textContent = '';
  els.mapStatus.textContent = '';
  els.exportB.classList.add('exportstep--locked');
  els.downloadMapBtn.disabled = true;
  clear(els.exportMessages);
  els.stepExport.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

els.backToReviewBtn.addEventListener('click', () => {
  els.stepReview.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

els.encryptToggle.addEventListener('change', () => {
  show(els.passphraseFields, els.encryptToggle.checked);
  clear(els.exportMessages);
  if (!els.encryptToggle.checked) {
    els.exportMessages.appendChild(note('warn', 'The map will be saved unencrypted', [
      'It will be plain readable text listing which token is which student. Store it as carefully as your gradebook, and delete it once you have restored the feedback.',
    ]));
  }
});

async function buildIfNeeded() {
  if (state.built) return state.built;
  state.built = await engine.run('build', {
    batchId: state.analysis.batchId,
    docs: state.analysis.docs,
    roster: state.analysis.roster,
    decisions: state.decisions,
    manual: state.manual,
    label: new Date().toISOString().slice(0, 10),
  }, { timeoutMs: 60_000 });
  return state.built;
}

els.downloadProtectedBtn.addEventListener('click', async () => {
  els.downloadProtectedBtn.disabled = true;
  els.protectedStatus.textContent = 'Preparing…';
  try {
    const built = await buildIfNeeded();
    const entries = built.protectedDocs.map((doc) => ({ name: doc.protectedFilename, text: doc.text }));
    entries.push({ name: 'SUGGESTED-PROMPT.txt', text: suggestedPrompt(built) });
    entries.push({ name: 'READ-ME-FIRST.txt', text: protectedReadme(built) });

    const blob = await engine.run('zip', { entries }, { timeoutMs: 60_000 });
    downloadBlob(blob, `protected_UPLOAD-TO-AI_${built.map.batchId}.zip`);

    state.protectedDownloaded = true;
    els.protectedStatus.textContent = `${built.protectedDocs.length} document(s) downloaded.`;
    els.exportB.classList.remove('exportstep--locked');
    els.downloadMapBtn.disabled = false;
    clear(els.exportMessages);
    els.exportMessages.appendChild(note('good', 'Now save your map', [
      'The second download is the file that maps tokens back to students. You need it to restore the feedback, and it must never be uploaded to an AI service.',
    ]));
  } catch (err) {
    els.protectedStatus.textContent = '';
    els.exportMessages.appendChild(note('danger', 'Export failed', [err.message]));
  } finally {
    els.downloadProtectedBtn.disabled = false;
  }
});

els.downloadMapBtn.addEventListener('click', async () => {
  if (!state.protectedDownloaded) return;
  clear(els.exportMessages);
  els.downloadMapBtn.disabled = true;
  els.mapStatus.textContent = 'Preparing…';

  try {
    const built = await buildIfNeeded();
    const json = JSON.stringify(built.map, null, 2);
    const base = `reidentification-map_KEEP-PRIVATE_${built.map.batchId}`;

    if (els.encryptToggle.checked) {
      const passphrase = els.passphrase.value;
      if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters, or turn encryption off deliberately.');
      if (passphrase !== els.passphrase2.value) throw new Error('The two passphrases do not match.');

      els.mapStatus.textContent = 'Encrypting…';
      // Verified encryption: the file is decrypted and compared before it is offered,
      // so a map that cannot be reopened never reaches the user's disk.
      const envelope = await encryptMapVerified(json, passphrase);
      downloadText(JSON.stringify(envelope, null, 2), `${base}.json.enc`, 'application/json');
      els.mapStatus.textContent = 'Encrypted map downloaded.';
    } else {
      downloadText(json, `${base}.json`, 'application/json');
      els.mapStatus.textContent = 'Unencrypted map downloaded.';
    }

    els.exportMessages.appendChild(note('good', 'Done', [
      'Upload only the protected archive. Keep the map on your own machine, and delete it once the feedback has been restored.',
    ]));
  } catch (err) {
    els.mapStatus.textContent = '';
    els.exportMessages.appendChild(note('danger', 'The map was not saved', [err.message]));
  } finally {
    els.downloadMapBtn.disabled = false;
  }
});

els.startOverBtn.addEventListener('click', () => {
  state.files = [];
  state.analysis = null;
  state.decisions = {};
  state.manual = [];
  state.built = null;
  state.protectedDownloaded = false;
  renderFileList();
  clear(els.fileProblems);
  clear(els.reviewMessages);
  show(els.stepReview, false);
  show(els.stepExport, false);
  updateReadiness();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* --------------------------------------------------------------- artefacts --- */

function suggestedPrompt(built) {
  const example = built.protectedDocs[0]?.docToken ?? '[PP_XXXXXXXX_D01]';
  return `Suggested prompt
================

Paste this above your own grading instructions.

---------------------------------------------------------------------------
The documents below have had names and other personal details replaced with
placeholder tokens that look like ${example}.

Two things I need from you:

1. Keep every token exactly as written, including the square brackets. Do not
   expand them, translate them, reformat them, or replace them with a name.

2. Begin your feedback for each document with a heading naming that document,
   exactly as shown here:

       ## Document ${example}

   Then write that document's feedback below its heading. Do not merge feedback
   for different documents into one section.
---------------------------------------------------------------------------

Why the heading matters: it is what lets the De-identification Assistant split a
single reply back into one feedback file per student. Without it you will still
get the names restored, but as one combined document.

Documents in this batch:

${built.protectedDocs.map((d) => `  ${d.docToken}  ->  ${d.protectedFilename}`).join('\n')}
`;
}

function protectedReadme(built) {
  return `This archive is safe to upload
==============================

Batch: ${built.map.batchId}
Created: ${built.map.createdAt}
Documents: ${built.protectedDocs.length}

The .md files here have had detected names and personal details replaced with
placeholder tokens. This is the archive to give to an AI service.

Do NOT upload the re-identification map, which downloads separately and has
"KEEP-PRIVATE" in its filename. That file is the list of which token is which
student.

When the feedback comes back, open the De-identification Assistant, go to the
Restore page, and load the map together with the feedback.

A reminder worth repeating: removing names does not always make a paper
anonymous. Details such as an unusual circumstance described in the text may
still identify a student to someone who knows the class.
`;
}

updateReadiness();
