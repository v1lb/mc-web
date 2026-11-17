// Tiny DOM helpers. Text always goes through textContent, never innerHTML: metadata values are untrusted.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'line', 'rect', 'g', 'polyline', 'text', 'use', 'defs', 'clipPath']);

/** h('button', { class: 'btn', onclick }, 'Label', child). Null and false children are skipped. */
export function h(tag, attrs, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.setAttribute('class', value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && !SVG_TAGS.has(tag) && key !== 'list' && key !== 'form') el[key] = value;
    else if (value !== false) el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

export function append(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) { el.replaceChildren(); return el; }

export function icon(name, size = 18) {
  const paths = {
    upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    search: 'm20 20-4.5-4.5M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
    studio: 'M4 20h4L19 9l-4-4L4 16v4Zm10-14 4 4',
    history: 'M4 12a8 8 0 1 0 2.6-5.9L4 8m0-4v4h4m4 0v4l3 2',
    settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3m-11 0h12v9H6v-9Z',
    pin: 'M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.800-6.500 11-6.500 11Zm0-8.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z',
    close: 'M6 6l12 12M18 6 6 18',
    file: 'M7 3h7l5 5v13H7V3Zm7 0v5h5',
    trash: 'M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13',
    check: 'm5 12.5 4.5 4.5L19 7.500',
    back: 'M15 5l-7 7 7 7',
    shield: 'M12 3 5 6v5.500c0 4.300 2.900 7.700 7 9.500 4.100-1.800 7-5.200 7-9.500V6l-7-3Z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
  };
  return h('svg', { class: 'icon', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d: paths[name] ?? '' }));
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Opens the system file dialog. Resolves to an array of File (empty when cancelled). */
export function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, class: 'visually-hidden' });
    if (directory) input.setAttribute('webkitdirectory', '');
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export const MEDIA_ACCEPT = 'image/*,video/mp4,video/quicktime,video/3gpp,.heic,.heif,.avif,.mov,.mp4,.m4v,.3gp';
