# Vendored third-party libraries

These files are committed to the repository so the application loads no third-party
code from a CDN. That improves the privacy story but means **updates are manual** —
see "Update procedure" below.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `mammoth.browser.min.js` | mammoth | 1.9.1 | BSD-2-Clause | `node_modules/mammoth/mammoth.browser.min.js` |
| `jszip.min.js` | jszip | 3.10.1 | MIT OR GPL-3.0-or-later | `node_modules/jszip/dist/jszip.min.js` |
| `pdf.min.mjs` | pdfjs-dist | 4.10.38 | Apache-2.0 | `node_modules/pdfjs-dist/build/pdf.min.mjs` |
| `pdf.worker.min.mjs` | pdfjs-dist | 4.10.38 | Apache-2.0 | `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` |

Full license texts are in `licenses/`.

## Update procedure

DOCX, PDF and ZIP parsers process untrusted input and are exactly the components that
receive security patches. Check them on a schedule (quarterly at minimum) and whenever
Dependabot opens an alert.

```bash
npm install --no-save mammoth@latest jszip@latest pdfjs-dist@latest
cp node_modules/mammoth/mammoth.browser.min.js vendor/
cp node_modules/jszip/dist/jszip.min.js vendor/
cp node_modules/pdfjs-dist/build/pdf.min.mjs vendor/pdf.min.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/pdf.worker.min.mjs
npm test && npx playwright test
```

Then update the version table above in the same commit. `pdf.min.mjs` and
`pdf.worker.min.mjs` must always come from the same pdfjs-dist version — mismatched
pairs fail at runtime.

## Why these are pinned, not bundled

The application ships plain ES modules with no build step. `vendor/` holds the
upstream browser builds unmodified; nothing in `src/` is minified or transpiled, so
anything the browser runs can be read in this repository.
