# DIA — Status and Next Steps

**Last updated:** 1 August 2026
**Repo:** https://github.com/rhoded-UWP/DIA (public, default branch `main`)
**Purpose of this file:** pick the project back up without re-deriving decisions that were
already argued through. `README.md` explains how the code is organised; this file explains
where things stand, what must not be casually undone, and what to do next.

---

## 1. Where things stand

**The application is complete and working for version 1.** Both flows run end to end,
in a real browser, under the production security policy.

| | |
|---|---|
| Unit tests | 117 passing (`npm test`) |
| End-to-end tests | 24 passing, Chromium (`npm run test:e2e`) |
| Commits | 4, all on `main` |
| Deployment | Render Blueprint synced, static site `dia` created — **confirm it reached "Live" and record the URL below** |
| Live URL | _(fill in)_ |

### What works

- **Protect:** roster in, papers in (`.docx`, `.pdf`, `.md`, `.txt`), review every match on
  screen, export two separate archives.
- **Restore:** map in (decrypting if needed), feedback in, names restored, batch replies
  split into one file per student, full report of anything questionable.
- **Everything is client-side.** No server, no LLM call, no network request during
  processing.

---

## 2. What has actually been verified

Not "written and assumed" — these were observed:

- Protected output contains none of the fixture students' names, emails, phones or IDs,
  and **neither do the filenames** (they are built purely from tokens; the original stem
  almost always carries the student's name).
- **The page cannot transmit.** `fetch`, `XMLHttpRequest`, `sendBeacon`, WebSocket and a
  tracking-pixel `<img>` are all refused. Verified by watching real request outcomes and
  CSP violation events — not by trusting each API's return value.
- **Unreadable files block export.** A scanned PDF, a partially image-based PDF, a
  corrupted `.docx` and an empty file all refuse rather than reporting "0 items found".
- A document full of XSS payloads renders as inert text; nothing executes.
- Wrong-batch tokens, damaged tokens, missing students and duplicated sections are all
  reported before the download button.
- Encryption round-trips, and a wrong passphrase fails with a generic message.

### A testing note worth remembering

An early version of the CSP test asserted `navigator.sendBeacon()` returns `false` when
blocked. **It does not** — it returns `true` once the request is *queued*, and the policy
check happens afterwards. The test now watches actual network outcomes instead. If you ever
extend the no-transmission tests, assert on observed traffic, never on an API's return
value.

---

## 3. Decisions that must not be casually reversed

Each of these looks like friction or over-engineering until you know why it is there.

### Positioning: "assists", never "certifies"

The tool must never claim a document is anonymous or that a use is FERPA-compliant.
De-identification under FERPA turns on whether someone in the school community could still
identify the student — and indirect identifiers ("the only student from Iceland in the
nursing program") are not detectable by software. The review screen and the honest UI copy
are **features**, not disclaimers to be tidied away.

### *United States v. Heppner* is background, described narrowly

S.D.N.Y., February 2026. Held that, *on the facts of that case*, a defendant's
self-directed exchanges with a public AI platform were not covered by attorney–client
privilege or work product. It is **not** a FERPA case and must never be presented as one.
Commentators consider the opinion possibly too categorical. Keep the wording in
`privacy.html` as it is unless you have read the opinion.

### Export is blocked while an ambiguous name is unresolved

With a Jane Smith and a Jane Jones enrolled, the bare word "Jane" is never auto-assigned.
An unresolved ambiguity means **a real name is still sitting in the text**, so "resolve it
later" cannot be a path that ends in a download. This is deliberate friction.

### All processing runs in a terminable Web Worker

Not for speed. A `setTimeout` cannot interrupt a synchronous regular expression, so a
cancel button on the main thread would be decorative — the UI would be frozen alongside the
work it was meant to stop. Only `worker.terminate()` can end a runaway job. Do not move
matching back to the main thread to "simplify".

### Two separate downloads

Browsers block two automatic downloads from one gesture anyway, and the second click is a
second chance to say the map must never be uploaded. Do not merge them into one archive.

### Batch splitting requires visible Markdown headings

`## Document [PP_…_D01]`, not HTML comments — chat UIs and models strip comments. A reply
without headings is **never** split; guessing where one student's feedback ends is exactly
the kind of confident wrongness this tool exists to avoid.

### Token design

`[PP_7K3M9Q2A_S07]` — an 8-character random batch namespace from `crypto.getRandomValues`,
with entity numbers **shuffled**. The namespace makes "restored with the wrong map" a
reported error instead of one student's name landing in another's feedback. The shuffle
exists because sequential numbering over an alphabetical roster leaks roster position.
Before tokenizing, documents are scanned for text already matching the token grammar, so a
student writing about placeholder syntax does not have their own words rewritten later.

### Recognizers are written to avoid catastrophic backtracking

No quantifier nested inside another. `test/redos.test.js` feeds every recognizer adversarial
input. The worker deadline is the backstop, **not** the defence. If you add a pattern, add
it to that suite.

### Maps are untrusted input on import

Even though this tool wrote them — they round-trip through a filesystem, an email
attachment, a shared drive. Token grammar, filename safety, field lengths, duplicate tokens
and unknown fields are all validated, and a newer schema version is refused rather than
guessed at.

### Dropped deliberately from the original plan

`protectedSha256` in the map. The restore flow consumes *feedback*, not protected files, so
the field had no consumer and would only have added surface to validate.

---

## 4. What it does and does not catch

**Structured PII is found for anyone; names are found only for your students.**

Caught regardless of the roster: email addresses, phone numbers, SSNs (punctuated forms),
credit cards (Luhn-validated), IP addresses, street addresses, dates of birth (only with a
birth phrase preceding), and student IDs (**only if an ID format is entered in step 1**).
Web addresses are off by default.

Not caught automatically: **names of anyone not on the roster** — a supervisor, a parent, a
roommate. There is no ML name model in this version. That is what the review screen's
"Redact selected text" is for, and it is stated on the landing page and in `privacy.html`.

Other current limits: no OCR (scanned PDFs refused); output is Markdown, so Word documents
do not come back as Word documents; no nickname matching (a roster listing "Robert" will not
match "Bob" — add the nickname as its own roster line); PDF text comes out in storage order,
which for multi-column layouts may not be reading order.

---

## 5. Next steps

### Immediate — finish the deployment

1. Confirm the Render service reached **Live**, and record the URL in the table above.
2. **Verify the security headers actually landed.** This is the one check that matters,
   because the site looks completely functional whether or not they applied. Open the
   deployed URL → DevTools → Network → click the `protect.html` request → Response Headers.
   Look for `content-security-policy` containing `connect-src 'none'`.
   If it is missing, the service was created outside the Blueprint — add the five headers by
   hand under Settings → Headers (all with path `/*`); they are listed in `render.yaml`.
3. Decide whether to keep **auto-deploy on push to `main`**. It is on by default, so a
   commit that breaks the page goes live ungated.

### Before any real student work goes near it

4. **Get institutional sign-off** — registrar, privacy office, or IT. The tool says this
   itself on every relevant screen. It is not legal advice and it does not speak for UW-Platteville.
5. Run one batch of your own real papers and read the protected output yourself before
   trusting it. Pay attention to what the review screen *did not* flag.

### Worth doing soon

6. Enable **Dependabot** on the repo. mammoth, pdf.js and JSZip parse untrusted files and
   are exactly the dependencies that receive security fixes. They are vendored (committed,
   not fetched from a CDN), which is better for privacy and worse for forgetting.
   Update procedure is in `vendor/VERSIONS.md`. Check quarterly at minimum.
7. Add a short instructor-facing "how to use this" page or handout, if you plan to share it
   with colleagues. The UI explains itself, but the *limitations* deserve a briefing.

### Version 2 backlog (in rough priority order)

| Feature | Why | Cost |
|---|---|---|
| In-browser ML name sweep (GLiNER via Transformers.js, ONNX) | Closes the biggest gap — unrostered names | 30–120 MB model download; probabilistic, so the review screen becomes essential rather than merely important |
| Nickname dictionary (Robert ↔ Bob) | Common, cheap, high value | Small |
| `.docx` → `.docx` round trip | Preserves formatting | Moderate; format-preserving find/replace inside OOXML |
| Optional audit export of discovered metadata | Some institutions want a record | Small, but it creates a second sensitive artifact — think first |
| Cross-browser E2E (Firefox, WebKit) | Instructors use everything | Small; mostly CI time |
| Service worker / offline package | Would let "works offline" be claimed honestly | Moderate; currently the docs deliberately say only "processing occurs locally after the page loads" |

---

## 6. Running it

```bash
npm install          # dev dependencies only; the app itself has none at runtime
npm run serve        # http://localhost:4173 — sends the same headers as production
npm test             # 117 unit tests
npm run test:e2e     # 24 Playwright tests (starts and stops its own server)
node tools/screenshots.js   # captures light and dark screenshots to .tmp/screens
```

`tools/serve.js` sends the real production headers, so the CSP is exercised in development
rather than discovered in production. Note that `npm run serve` runs until you stop it —
that is normal for a web server, not a hang.

### Vendored libraries

| Library | Version | Purpose |
|---|---|---|
| mammoth | 1.9.1 | Word text extraction |
| JSZip | 3.10.1 | `.docx` inspection, archive building |
| pdfjs-dist | 4.10.38 | PDF text layer + metadata |

`pdf.min.mjs` and `pdf.worker.min.mjs` must always come from the same pdfjs-dist version;
mismatched pairs fail at runtime.

---

## 7. Open questions

- Does UW-Platteville have a fixed student ID format worth pre-filling as the default?
- Should the tool ship with the institution's own guidance linked from `privacy.html`?
- Is there appetite for a shared/hosted instance for colleagues, or is per-instructor use
  from the public URL sufficient? (Nothing about the architecture changes either way —
  there is no server state.)
