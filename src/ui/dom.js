/**
 * DOM helpers.
 *
 * Every one of these builds nodes and sets textContent. Nothing in this project assigns
 * innerHTML with values that came out of a document, a roster, a filename or a map —
 * all of those are untrusted, and a student's paper containing <img onerror=...> should
 * be a boring string on screen rather than an event.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * el('button', { class: 'btn', onclick: fn, disabled: true }, 'Label')
 * Children may be nodes, strings, or nested arrays; strings always become text nodes.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function show(node, visible = true) {
  if (node) node.hidden = !visible;
}

/** A short, quoted excerpt for use in messages. */
export function excerpt(value, max = 60) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Hand a Blob to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: revoking it in the
 * same task can cancel the download in some browsers before it has started reading.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** Build a note box. `lines` may be strings or nodes. */
export function note(kind, title, lines = []) {
  const box = el('div', { class: `note note--${kind}` });
  if (title) box.appendChild(el('strong', { class: 'note__title', text: title }));
  const items = [].concat(lines);
  if (items.length === 1 && typeof items[0] === 'string') {
    box.appendChild(el('p', { text: items[0] }));
  } else if (items.length > 0) {
    box.appendChild(el('ul', {}, items.map((line) => el('li', {}, line))));
  }
  return box;
}

export function pill(kind, label) {
  return el('span', { class: `pill pill--${kind}`, text: label });
}

/** Wire a drop zone plus its hidden file input to one callback. */
export function wireDropzone(zone, input, onFiles) {
  const stop = (event) => { event.preventDefault(); event.stopPropagation(); };

  zone.addEventListener('dragover', (event) => { stop(event); zone.classList.add('dropzone--over'); });
  zone.addEventListener('dragleave', (event) => { stop(event); zone.classList.remove('dropzone--over'); });
  zone.addEventListener('drop', (event) => {
    stop(event);
    zone.classList.remove('dropzone--over');
    onFiles([...(event.dataTransfer?.files ?? [])]);
  });
  zone.addEventListener('click', (event) => {
    if (event.target !== input) input.click();
  });
  input.addEventListener('change', () => {
    onFiles([...input.files]);
    input.value = '';
  });
}

/** Mark the current page in the site navigation. */
export function markCurrentNav() {
  const here = location.pathname.split('/').pop() || 'index.html';
  for (const link of $$('.nav a')) {
    if (link.getAttribute('href') === here) link.setAttribute('aria-current', 'page');
  }
}
