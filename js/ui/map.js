// Maps. The schematic world map is drawn from a bundled outline, with no network requests at all.
// Real map tiles are requested from OpenStreetMap only after the visitor presses the button.

import { h, clear, icon } from './dom.js';
import { t } from '../i18n.js';

let outline = null;

/** Coastline polylines as one SVG path in a 360×180 plane (x = lon + 180, y = 90 − lat). */
async function worldPath() {
  if (outline != null) return outline;
  try {
    const text = await (await fetch('assets/world.txt')).text();
    outline = text.trim().split('\n').map((line) => line.split(';').map((pair, i) => {
      const [lon, lat] = pair.split(',').map(Number);
      return `${i ? 'L' : 'M'}${(lon + 180).toFixed(2)} ${(90 - lat).toFixed(2)}`;
    }).join('')).join('');
  } catch { outline = ''; }
  return outline;
}

function grid(step) {
  const lines = [];
  for (let lon = -180; lon <= 180; lon += step) lines.push(h('line', { x1: lon + 180, y1: 0, x2: lon + 180, y2: 180 }));
  for (let lat = -90; lat <= 90; lat += step) lines.push(h('line', { x1: 0, y1: 90 - lat, x2: 360, y2: 90 - lat }));
  return h('g', { class: 'map-grid' }, lines);
}

/**
 * Schematic map. [span]: visible degrees of longitude (360 = whole world). [onPick] makes it clickable and
 * receives { latitude, longitude }.
 */
export function schematicMap({ point = null, span = 360, onPick = null, label = '' } = {}) {
  const width = span, height = span / 2;
  const cx = point && span < 360 ? Math.min(360 - width / 2, Math.max(width / 2, point.longitude + 180)) : 180;
  const cy = point && span < 360 ? Math.min(180 - height / 2, Math.max(height / 2, 90 - point.latitude)) : 90;
  const land = h('path', { class: 'map-land', d: '' });
  const marker = h('g', { class: 'map-marker' });
  const r = span / 90;
  const place = (p) => {
    clear(marker);
    if (!p) return;
    const x = p.longitude + 180, y = 90 - p.latitude;
    marker.append(h('circle', { cx: x, cy: y, r: r * 3, class: 'map-halo' }), h('circle', { cx: x, cy: y, r, class: 'map-dot' }));
  };
  place(point);
  const svg = h('svg', { class: `map-svg${onPick ? ' is-pickable' : ''}`, viewBox: `${cx - width / 2} ${cy - height / 2} ${width} ${height}`,
    role: 'img', 'aria-label': label || t('web_map_schematic'), preserveAspectRatio: 'xMidYMid meet' },
  h('rect', { x: 0, y: 0, width: 360, height: 180, class: 'map-sea' }), grid(span >= 180 ? 30 : 10), land, marker);
  worldPath().then((d) => land.setAttribute('d', d));
  if (onPick) {
    svg.addEventListener('click', (event) => {
      const box = svg.getBoundingClientRect();
      // The picture keeps its 2:1 ratio inside the element: account for letterboxing.
      const scale = Math.min(box.width / width, box.height / height);
      const x = (event.clientX - box.left - (box.width - width * scale) / 2) / scale + cx - width / 2;
      const y = (event.clientY - box.top - (box.height - height * scale) / 2) / scale + cy - height / 2;
      const picked = { latitude: Math.max(-90, Math.min(90, 90 - y)), longitude: Math.max(-180, Math.min(180, x - 180)) };
      place(picked);
      onPick(picked);
    });
  }
  return svg;
}

const TILE = 256;

/** Raster map around the point with zoom buttons. Tiles come from tile.openstreetmap.org. */
export function tileMap(point) {
  let zoom = 13;
  const layer = h('div', { class: 'tiles-layer' });
  const view = h('div', { class: 'tiles', role: 'img', 'aria-label': `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}` }, layer,
    h('div', { class: 'tiles-pin' }, icon('pin', 30)));
  const render = () => {
    clear(layer);
    const n = 2 ** zoom;
    const x = ((point.longitude + 180) / 360) * n;
    const latRad = (Math.max(-85.05, Math.min(85.05, point.latitude)) * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const w = view.clientWidth || 640, hgt = view.clientHeight || 360;
    const left = x * TILE - w / 2, top = y * TILE - hgt / 2;
    for (let tx = Math.floor(left / TILE); tx * TILE < left + w; tx++) {
      for (let ty = Math.floor(top / TILE); ty * TILE < top + hgt; ty++) {
        if (ty < 0 || ty >= n) continue;
        const img = h('img', { class: 'tile', alt: '', draggable: false, referrerPolicy: 'strict-origin-when-cross-origin',
          src: `https://tile.openstreetmap.org/${zoom}/${((tx % n) + n) % n}/${ty}.png` });
        img.style.left = `${Math.round(tx * TILE - left)}px`;
        img.style.top = `${Math.round(ty * TILE - top)}px`;
        layer.append(img);
      }
    }
  };
  const step = (delta) => { zoom = Math.max(2, Math.min(18, zoom + delta)); render(); };
  const controls = h('div', { class: 'tiles-zoom' },
    h('button', { class: 'btn btn-square', type: 'button', title: t('web_map_zoom_in'), 'aria-label': t('web_map_zoom_in'), onclick: () => step(1) }, icon('plus')),
    h('button', { class: 'btn btn-square', type: 'button', title: t('web_map_zoom_out'), 'aria-label': t('web_map_zoom_out'), onclick: () => step(-1) }, icon('minus')));
  view.append(controls, h('div', { class: 'tiles-credit' }, t('web_map_attribution')));
  requestAnimationFrame(render);
  new ResizeObserver(render).observe(view);
  return view;
}
