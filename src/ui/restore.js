/**
 * The restore flow.
 *
 * The report is not optional decoration. Restoration can go wrong in ways that look like
 * success — feedback for a student who is missing entirely, a token from last week's
 * batch, a token an LLM helpfully "tidied" into something else — and every one of those
 * is shown before the download button, not after.
 */

import { $, el, clear, show, note, downloadBlob, downloadText, wireDropzone, markCurrentNav } from './dom.js';
import { engine } from '../worker/engineHost.js';
import { parseAndValidateMap } from '../engine/mapSchema.js';
import { decryptMap, isEncryptedEnvelope } from '../engine/crypto.js';
import { summarizeReport } from '../engine/restore.js';
import { LIMITS, formatBytes } from '../engine/limits.js';
import { sanitizeFilename } from '../engine/filenames.js';

markCurrentNav();

const state = {
  map: null,
  encryptedEnvelope: null,
  feedbackFiles: [],
  result: null,
  activeIndex: 0,
};

const els = {
  mapDropzone: $('#map-dropzone'),
  mapInput: $('#map-input'),
  mapStatus: $('#map-status'),
  passphrasePrompt: $('#passphrase-prompt'),
  mapPassphrase: $('#map-passphrase'),
  unlockBtn: $('#unlock-btn'),
  feedbackDropzone: $('#feedback-dropzone'),
  feedbackInput: $('#feedback-input'),
  feedbackFilelist: $('#feedback-filelist'),
  feedbackText: $('#feedback-text'),
  lenientToggle: $('#lenient-toggle'),
  restoreBtn: $('#restore-btn'),
  restoreGateNote: $('#restore-gate-note'),
  stepResult: $('#step-result'),
  resultStats: $('#result-stats'),
  resultMessages: $('#result-messages'),
  resultTabs: $('#result-tabs'),
  resultPreview: $('#result-preview'),
  downloadRestoredBtn: $('#download-restored-btn'),
  copyRestoredBtn: $('#copy-restored-btn'),
  downloadStatus: $('#download-status'),
};

/* --------------------------------------------------------------------- map --- */

wireDropzone(els.mapDropzone, els.mapInput, (files) => loadMapFile(files[0]));
els.mapDropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); els.mapInput.click(); }
});

async function loadMapFile(file) {
  if (!file) return;
  clear(els.mapStatus);
  show(els.passphrasePrompt, false);
  state.map = null;
  state.encryptedEnvelope = null;

  if (file.size > LIMITS.maxMapBytes) {
    els.mapStatus.appendChild(note('danger', 'That file is too large to be a map', [formatBytes(file.size)]));
    updateGate();
    return;
  }

  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    els.mapStatus.appendChild(note('danger', 'That file could not be read', [
      'It is not valid JSON. Make sure you picked the re-identification map and not one of the protected documents.',
    ]));
    updateGate();
    return;
  }

  if (isEncryptedEnvelope(parsed)) {
    state.encryptedEnvelope = parsed;
    show(els.passphrasePrompt, true);
    els.mapStatus.appendChild(note('', 'This map is encrypted', ['Enter the passphrase you chose when you exported it.']));
    els.mapPassphrase.focus();
    updateGate();
    return;
  }

  acceptMap(parsed, 'This map is not encrypted');
}

els.unlockBtn.addEventListener('click', unlockMap);
els.mapPassphrase.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') unlockMap();
});

async function unlockMap() {
  if (!state.encryptedEnvelope) return;
  clear(els.mapStatus);
  els.unlockBtn.disabled = true;
  try {
    const json = await decryptMap(state.encryptedEnvelope, els.mapPassphrase.value);
    const { ok, errors, map } = parseAndValidateMap(json);
    if (!ok) throw new Error(errors[0]);
    els.mapPassphrase.value = '';
    show(els.passphrasePrompt, false);
    finishMap(map, 'Map unlocked');
  } catch (err) {
    els.mapStatus.appendChild(note('danger', 'The map was not opened', [err.message]));
  } finally {
    els.unlockBtn.disabled = false;
    updateGate();
  }
}

function acceptMap(parsedJson, headline) {
  const { ok, errors, map } = parseAndValidateMap(JSON.stringify(parsedJson));
  if (!ok) {
    els.mapStatus.appendChild(note('danger', 'That map could not be used', errors.slice(0, 6)));
    updateGate();
    return;
  }
  finishMap(map, headline);
}

function finishMap(map, headline) {
  state.map = map;
  clear(els.mapStatus);
  els.mapStatus.appendChild(note('good', headline, [
    `Batch ${map.batchId} — ${map.documents.length} document(s), ${map.entities.length} item(s) that can be restored.` +
    (map.label ? ` Labelled "${map.label}".` : ''),
  ]));
  updateGate();
}

/* ---------------------------------------------------------------- feedback --- */

wireDropzone(els.feedbackDropzone, els.feedbackInput, addFeedbackFiles);
els.feedbackDropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); els.feedbackInput.click(); }
});
els.feedbackText.addEventListener('input', updateGate);

async function addFeedbackFiles(files) {
  for (const file of files) {
    if (file.size > LIMITS.maxFileBytes) continue;
    state.feedbackFiles.push({ name: file.name, text: await file.text() });
  }
  renderFeedbackList();
  updateGate();
}

function renderFeedbackList() {
  clear(els.feedbackFilelist);
  for (const [index, entry] of state.feedbackFiles.entries()) {
    els.feedbackFilelist.appendChild(el('li', {},
      el('span', { class: 'filelist__name', text: entry.name }),
      el('span', { class: 'filelist__meta', text: `${entry.text.length.toLocaleString()} characters` }),
      el('button', {
        type: 'button', class: 'btn-sm',
        'aria-label': `Remove ${entry.name}`,
        onclick: () => {
          state.feedbackFiles.splice(index, 1);
          renderFeedbackList();
          updateGate();
        },
      }, 'Remove'),
    ));
  }
}

function feedbackInputs() {
  const inputs = [...state.feedbackFiles];
  const pasted = els.feedbackText.value.trim();
  if (pasted) inputs.push({ name: 'pasted-reply.md', text: els.feedbackText.value });
  return inputs;
}

function updateGate() {
  const hasMap = state.map !== null;
  const hasFeedback = feedbackInputs().length > 0;
  els.restoreBtn.disabled = !hasMap || !hasFeedback;
  els.restoreGateNote.textContent = !hasMap
    ? 'Load your re-identification map first.'
    : !hasFeedback ? 'Add the feedback files, or paste the reply.' : '';
}

/* ----------------------------------------------------------------- restore --- */

els.restoreBtn.addEventListener('click', async () => {
  els.restoreBtn.disabled = true;
  clear(els.resultMessages);
  try {
    state.result = await engine.run('restore', {
      map: state.map,
      inputs: feedbackInputs(),
      lenient: els.lenientToggle.checked,
    }, { timeoutMs: 60_000 });
    state.activeIndex = 0;
    renderResult();
  } catch (err) {
    els.resultMessages.appendChild(note('danger', 'Restore failed', [err.message]));
    show(els.stepResult, true);
  } finally {
    updateGate();
  }
});

function renderResult() {
  const { outputs, report } = state.result;
  show(els.stepResult, true);

  clear(els.resultStats);
  const problems = report.missingDocuments.length + report.duplicateDocuments.length +
    report.unknownTokens.length + report.wrongBatchTokens.length + report.alteredTokenSuspects.length;
  const stats = [
    ['Names restored', report.replacements, false],
    ['Files produced', outputs.length, false],
    ['Documents accounted for', `${report.foundDocuments} of ${report.expectedDocuments}`, report.foundDocuments < report.expectedDocuments],
    ['Things to check', problems, problems > 0],
  ];
  for (const [label, value, alert] of stats) {
    els.resultStats.appendChild(el('div', { class: `stat${alert ? ' stat--alert' : ''}` },
      el('div', { class: 'stat__value', text: String(value) }),
      el('div', { class: 'stat__label', text: label }),
    ));
  }

  clear(els.resultMessages);
  els.resultMessages.appendChild(note(problems > 0 ? 'warn' : 'good', 'Summary', summarizeReport(report)));

  if (report.missingDocuments.length) {
    els.resultMessages.appendChild(note('warn', 'No feedback was found for these documents', [
      ...report.missingDocuments.map((d) => `${d.originalFilename || d.docId} (${d.docToken})`),
      'Either the AI skipped them, or its reply did not include the document headings that identify each section.',
    ]));
  }
  if (report.duplicateDocuments.length) {
    els.resultMessages.appendChild(note('warn', 'These documents appeared more than once', [
      ...report.duplicateDocuments.map((d) => `${d.docToken} appeared ${d.count} times`),
      'Check that the right feedback went to the right student before sending anything out.',
    ]));
  }
  if (report.wrongBatchTokens.length) {
    els.resultMessages.appendChild(note('danger', 'Tokens from a different batch were left untouched', [
      ...report.wrongBatchTokens.slice(0, 10),
      'This usually means the feedback belongs to a different set of papers than this map. Check that you loaded the matching map.',
    ]));
  }
  if (report.unknownTokens.length) {
    els.resultMessages.appendChild(note('warn', 'Tokens this map does not know were left untouched', report.unknownTokens.slice(0, 10)));
  }
  if (report.alteredTokenSuspects.length) {
    els.resultMessages.appendChild(note('warn', 'Some text looks like a token the AI reformatted', [
      ...report.alteredTokenSuspects.slice(0, 10).map((s) => (typeof s === 'string' ? s : s.text)),
      'These were left exactly as they are. If they are yours, turn on "Repair tokens the AI reformatted" and restore again.',
    ]));
  }
  if (report.repairedTokens.length) {
    els.resultMessages.appendChild(note('warn', 'Damaged tokens were repaired', [
      ...report.repairedTokens.slice(0, 10).map((r) => `${r.found} → ${r.repairedTo}`),
      'Check these against the original feedback before you send it.',
    ]));
  }

  renderResultTabs();
  renderResultPreview();
  els.stepResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResultTabs() {
  clear(els.resultTabs);
  state.result.outputs.forEach((output, index) => {
    els.resultTabs.appendChild(el('button', {
      type: 'button', class: 'doctab', role: 'tab',
      'aria-selected': String(index === state.activeIndex),
      onclick: () => { state.activeIndex = index; renderResultTabs(); renderResultPreview(); },
    }, output.filename));
  });
}

function renderResultPreview() {
  const output = state.result.outputs[state.activeIndex];
  clear(els.resultPreview);
  // Restored feedback contains real student names and comes from an external service.
  // It goes on screen as text, never as markup.
  els.resultPreview.appendChild(document.createTextNode(output?.text ?? ''));
}

/* ---------------------------------------------------------------- download --- */

els.downloadRestoredBtn.addEventListener('click', async () => {
  const { outputs } = state.result;
  els.downloadStatus.textContent = 'Preparing…';
  try {
    if (outputs.length === 1) {
      downloadText(outputs[0].text, sanitizeFilename(outputs[0].filename), 'text/markdown;charset=utf-8');
    } else {
      const entries = outputs.map((o) => ({ name: sanitizeFilename(o.filename), text: o.text }));
      entries.push({ name: 'RESTORE-REPORT.txt', text: summarizeReport(state.result.report).join('\n') + '\n' });
      const blob = await engine.run('zip', { entries }, { timeoutMs: 60_000 });
      downloadBlob(blob, `restored_feedback_${state.map.batchId}.zip`);
    }
    els.downloadStatus.textContent = 'Downloaded.';
  } catch (err) {
    els.downloadStatus.textContent = '';
    els.resultMessages.appendChild(note('danger', 'Download failed', [err.message]));
  }
});

els.copyRestoredBtn.addEventListener('click', async () => {
  const output = state.result.outputs[state.activeIndex];
  try {
    await navigator.clipboard.writeText(output.text);
    els.downloadStatus.textContent = `Copied "${output.filename}".`;
  } catch {
    els.downloadStatus.textContent = 'The browser blocked clipboard access. Select the text and copy it by hand.';
  }
});

updateGate();
