# De-identification Assistant (DIA)

A free, entirely client-side tool for instructors and students who want to use a large
language model for grading or feedback without sending student names and personal details
to it.

It works like a reversible archive for identity: it replaces detected personal information
with placeholder tokens, gives you a private map of what those tokens mean, and later puts
the real names back into the feedback the model returns. **The application never calls a
large language model, and never uploads anything.**

```
papers + roster ──► protect ──► protected .md files ──► [ you paste into any AI ]
                        │                                          │
                        └──► private map (encrypted) ──► restore ◄──┘
                                                            │
                                                    feedback with real names
```

## What it is not

It **assists** with de-identification. It does not certify that a document is anonymous, and
it cannot make a FERPA determination for you. Removing names does not remove
identifiability: a student who writes that they are the only person from their country in
the program is still identifiable to anyone who knows the class. The review screen exists
so you can catch those yourself, and the interface says so rather than implying the job is
finished. See [`privacy.html`](privacy.html) for the full discussion.

## Running it locally

```bash
npm install
npm run serve
```

Then open <http://localhost:4173>. `tools/serve.js` sends the same response headers
configured in `render.yaml`, so the Content-Security-Policy is exercised in development
rather than discovered in production.

## Tests

```bash
npm test
```

115 unit tests over the engine — pure ES modules with no DOM or network dependencies, so
the same code runs under `node --test` and inside the browser worker.

```bash
npm run test:e2e
```

24 Playwright tests (Chromium) covering the full protect → restore round trip and the
failure modes: scanned PDFs, corrupted files, hostile document content, tampered maps,
path traversal in filenames, wrong-batch tokens, and whether the page can reach the network
at all.

Cross-browser runs (Firefox, WebKit) are not wired up yet.

## How it is put together

```
index.html  protect.html  restore.html  privacy.html
css/style.css
src/
  engine/      pure logic, no DOM: tokens, roster matching, recognizers,
               anonymize/restore, crypto, map validation, limits
  extract/     docx (mammoth + JSZip), pdf (pdf.js), plain text
  worker/      the engine worker and its main-thread host
  ui/          page controllers and safe DOM helpers
vendor/        third-party browser builds, unmodified — see vendor/VERSIONS.md
test/          node --test suites
e2e/           Playwright suites
tools/serve.js dev/test server with production headers
```

No build step. The JavaScript that runs in the browser is the JavaScript in this
repository.

### Why there is a Web Worker

All document processing runs in `src/worker/engine.worker.js`. This is not for speed. A
`setTimeout` cannot interrupt a synchronous regular expression, so a cancel button on the
main thread would be decorative — the UI would be frozen alongside the work it was meant to
stop. Only `worker.terminate()` can end a runaway job, so the work has to live somewhere
terminable. Every job carries a deadline; on timeout or cancel the worker is destroyed and
a clean one is started for the next job.

The recognizers are written to avoid catastrophic backtracking, and `test/redos.test.js`
feeds each of them adversarial input as a guard against a future edit reintroducing it. The
worker deadline is the backstop, not the defence.

### Tokens

```
[PP_7K3M9Q2A_S07]
     │        └── entity type and number, assigned in randomised order
     └─────────── 8-character batch namespace from crypto.getRandomValues
```

The namespace is not secret. Its job is to make restoring feedback with the wrong map an
error that gets reported, rather than one student's name being written into another
student's feedback. Numbers are shuffled because sequential numbering over an alphabetical
roster would leak roster position.

Before tokenizing, every document is scanned for text already matching the token grammar,
so a student who happens to write about placeholder syntax does not have their own words
rewritten during restoration.

### The map

`reidentification-map_KEEP-PRIVATE_<batch>.json` lists which token means which student. It
is the most sensitive artifact the tool produces — effectively a small roster — and it is
encrypted by default with AES-256-GCM, using a key derived by PBKDF2-SHA-256 at 600,000
iterations, a fresh 128-bit salt and 96-bit IV per file, and the envelope's declared
algorithm fields bound in as additional authenticated data. On import, iteration counts
outside 100,000–2,000,000 are refused before any work happens, so a crafted file cannot
freeze the browser.

Encryption is verified before the file is offered for download: the tool decrypts what it
just produced and compares. A map that cannot be reopened never reaches disk.

Maps are treated as untrusted input on import — token grammar, filename safety, field
lengths, duplicate tokens and unknown fields are all checked, and a newer schema version is
refused rather than guessed at.

### Detection

Names come from the roster you supply. Partial matches (first name only, surname only)
become automatic **only when they are unique across the roster**; with a Jane Smith and a
Jane Jones enrolled, the word "Jane" is reported for you to assign. Initials always require
confirmation. Export is blocked while any of those are unresolved, because an unresolved
ambiguity is a real name still sitting in the text.

Structured PII (email, phone, SSN, cards with a Luhn check, IPs, addresses, dates of birth
with birth context, and an ID format you specify) is matched by recognizers following the
Presidio and DataFog pattern sets, rewritten for JavaScript. There is no machine-learning
model in this version, so a person mentioned in an essay who is not on the roster will not
be found automatically — redact those by hand on the review screen.

## Deployment

Static site on Render, configured by `render.yaml`, which sets the CSP and other security
headers as real response headers. The free static tier is sufficient; the running cost is
close to zero.

The real ongoing cost is **maintenance**. mammoth, pdf.js and JSZip parse untrusted files
and are exactly the kind of dependency that receives security fixes. They are vendored
(committed, not fetched from a CDN), which is better for privacy and worse for forgetting —
`vendor/VERSIONS.md` records versions and the update procedure. Check them quarterly at
minimum.

## Limitations in this version

- Roster names only; no ML model for unrostered people
- No OCR, so scanned PDFs are refused rather than processed
- Output is Markdown text; Word documents do not come back as Word documents
- No nickname matching (a roster listing "Robert" will not match "Bob" on its own)
- PDF text comes out in storage order, which for multi-column layouts may not be reading order
- Chromium-only end-to-end tests

## License and third-party code

Vendored libraries keep their own licenses, reproduced in `vendor/licenses/`:
mammoth (BSD-2-Clause), JSZip (MIT or GPL-3.0-or-later), pdf.js (Apache-2.0).
