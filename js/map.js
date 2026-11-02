// Mapa do local (OpenStreetMap, grátis e sem chave): alfinete para marcar o ponto exato,
// mapa pequeno para ver e links de rota no Google Maps e no Waze.
// O Leaflet (biblioteca do mapa) só é baixado quando um mapa aparece na tela.
import { esc } from './util.js';

const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist';
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const BRASIL = { lat: -14.24, lng: -51.93, zoom: 4 };

let leaflet;
function loadLeaflet() {
  leaflet ??= (async () => {
    if (!document.querySelector('link[data-leaflet]')) {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${LEAFLET}/leaflet.css` });
      css.dataset.leaflet = '';
      document.head.appendChild(css);
    }
    return import(`${LEAFLET}/leaflet-src.esm.js`);
  })();
  leaflet.catch(() => (leaflet = null));
  return leaflet;
}

const hasPin = (p) => p && p.lat != null && p.lng != null;
export const isOnline = (address) => /^\s*on-?line\s*$/i.test(address || '');

// Rota até o local: pelo alfinete, se houver; senão, pelo endereço digitado.
export function routeLinks(place) {
  if (hasPin(place)) {
    const ll = `${place.lat},${place.lng}`;
    return {
      google: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
      waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    };
  }
  const q = encodeURIComponent(place.address);
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
  };
}

// Bloco do local nas telas: mapa pequeno (se houver alfinete) e os botões de rota.
export function placeBlock(place) {
  if (!hasPin(place) && (!place.address || isOnline(place.address))) return '';
  const r = routeLinks(place);
  return `
    <div class="place">
      ${hasPin(place) ? `<div class="place-map" data-lat="${place.lat}" data-lng="${place.lng}" role="img" aria-label="Mapa do local"></div>` : ''}
      <div class="actions-row place-routes">
        <a class="btn small" href="${esc(r.google)}" target="_blank" rel="noopener">Rota no Google Maps</a>
        <a class="btn small" href="${esc(r.waze)}" target="_blank" rel="noopener">Ir com o Waze</a>
      </div>
    </div>`;
}

const pinIcon = (L) =>
  L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [30, 40], iconAnchor: [15, 40] });

// Desenha os mapas pequenos da tela (só para ver: sem arrastar, sem zoom).
export async function mountPlaceMaps(root = document) {
  const boxes = [...root.querySelectorAll('.place-map:not([data-ready])')];
  if (!boxes.length) return;
  let L;
  try {
    L = await loadLeaflet();
  } catch {
    return boxes.forEach((b) => b.remove());
  }
  for (const box of boxes) {
    if (!box.isConnected) continue;
    box.dataset.ready = '';
    const at = [Number(box.dataset.lat), Number(box.dataset.lng)];
    const map = L.map(box, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false })
      .setView(at, 16);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    L.marker(at, { icon: pinIcon(L), interactive: false }).addTo(map);
  }
}

// Busca de endereço (Nominatim, do OpenStreetMap): poucos pedidos, só ao tocar em Buscar.
async function searchAddress(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=br&accept-language=pt-BR&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('A busca de endereço não respondeu. Tente de novo em instantes.');
  return (await res.json()).map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), label: r.display_name }));
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// Janela para marcar o ponto: toque no mapa ou arraste o alfinete.
// Devolve { lat, lng } ao confirmar, null ao remover o alfinete e undefined ao cancelar.
export function pickLocation({ lat, lng, address, near }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop map-backdrop';
    wrap.innerHTML = `
      <div class="modal map-modal" role="dialog" aria-modal="true" aria-labelledby="map-title">
        <h2 id="map-title">Marcar no mapa</h2>
        <form class="map-search">
          <input name="q" type="search" placeholder="Buscar endereço" value="${esc(address || '')}" aria-label="Buscar endereço">
          <button class="btn small">Buscar</button>
        </form>
        <div class="map-results list" hidden></div>
        <div class="map-pick" id="map-pick"><p class="hint center">Carregando o mapa…</p></div>
        <p class="hint">Toque no mapa ou arraste o alfinete até a porta do local.</p>
        <div class="actions-row">
          <button class="btn small" type="button" data-act="me">Usar minha localização</button>
          ${hasPin({ lat, lng }) ? '<button class="btn small danger-outline" type="button" data-act="remove">Remover do mapa</button>' : ''}
        </div>
        <div class="actions-row">
          <button class="btn" type="button" data-act="cancel">Cancelar</button>
          <button class="btn primary" type="button" data-act="ok" disabled>Usar este ponto</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = (value) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => e.key === 'Escape' && close(undefined);
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => e.target === wrap && close(undefined));

    const okBtn = wrap.querySelector('[data-act=ok]');
    const results = wrap.querySelector('.map-results');
    let L, map, marker;
    let point = hasPin({ lat, lng }) ? { lat, lng } : null;
    const place = (p, zoom) => {
      point = { lat: round(p.lat), lng: round(p.lng) };
      if (!map) return;
      if (marker) marker.setLatLng([point.lat, point.lng]);
      else {
        marker = L.marker([point.lat, point.lng], { icon: pinIcon(L), draggable: true, autoPan: true }).addTo(map);
        marker.on('dragend', () => place(marker.getLatLng()));
      }
      if (zoom) map.setView([point.lat, point.lng], zoom);
      okBtn.disabled = false;
    };

    loadLeaflet()
      .then((lib) => {
        if (!wrap.isConnected) return;
        L = lib;
        const box = wrap.querySelector('#map-pick');
        box.innerHTML = '';
        const start = point || near || BRASIL;
        map = L.map(box).setView([start.lat, start.lng], point ? 17 : near ? 15 : BRASIL.zoom);
        L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
        map.on('click', (e) => place(e.latlng));
        if (point) place(point);
        // Sem alfinete, mas com endereço: já procura o endereço digitado.
        else if (address && !isOnline(address)) wrap.querySelector('.map-search').requestSubmit();
      })
      .catch(() => {
        wrap.querySelector('#map-pick').innerHTML = '<p class="hint warn center">Não foi possível carregar o mapa. Confira a internet.</p>';
      });

    wrap.querySelector('.map-search').addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = e.target.q.value.trim();
      if (q.length < 3) return;
      results.hidden = false;
      results.innerHTML = '<p class="hint">Buscando…</p>';
      try {
        const found = await searchAddress(q);
        if (!found.length) return (results.innerHTML = '<p class="hint">Endereço não encontrado. Tente só a rua e a cidade, ou toque no mapa.</p>');
        results.innerHTML = found
          .map((r, i) => `<button type="button" class="menu-row" data-i="${i}"><span>${esc(r.label)}</span></button>`)
          .join('');
        results.querySelectorAll('[data-i]').forEach((b) => {
          b.onclick = () => {
            place(found[Number(b.dataset.i)], 18);
            results.hidden = true;
          };
        });
        if (found.length === 1) results.querySelector('[data-i]').click();
      } catch (err) {
        results.innerHTML = `<p class="hint warn">${esc(err.message)}</p>`;
      }
    });

    wrap.querySelector('[data-act=me]').onclick = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => place({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 18),
        () => {
          results.hidden = false;
          results.innerHTML = '<p class="hint warn">Não foi possível pegar a sua localização. Libere a localização para este site ou toque no mapa.</p>';
        },
        { enableHighAccuracy: true, timeout: 15000 },
      );
    };
    wrap.querySelector('[data-act=remove]')?.addEventListener('click', () => close(null));
    wrap.querySelector('[data-act=cancel]').onclick = () => close(undefined);
    okBtn.onclick = () => close(point);
  });
}

// Campo do formulário: mostra se há alfinete e abre a janela do mapa.
// Guarda lat/lng em campos escondidos do próprio formulário.
export function pinField(place) {
  return `
    <div class="pin-field">
      <input type="hidden" name="lat" value="${place.lat ?? ''}">
      <input type="hidden" name="lng" value="${place.lng ?? ''}">
      <span class="pin-status"></span>
      <button class="btn small" type="button" data-pin>Marcar no mapa</button>
    </div>`;
}

// address: função que devolve o endereço digitado (para a busca começar por ele).
export function bindPinField(form, { address, near } = {}) {
  const box = form.querySelector('.pin-field');
  if (!box) return;
  const status = box.querySelector('.pin-status');
  const btn = box.querySelector('[data-pin]');
  const show = () => {
    const on = form.lat.value !== '';
    status.textContent = on ? '📍 Local marcado no mapa' : 'Sem alfinete no mapa';
    status.classList.toggle('ok', on);
    btn.textContent = on ? 'Mudar no mapa' : 'Marcar no mapa';
  };
  show();
  btn.onclick = async () => {
    const current = form.lat.value !== '' ? { lat: Number(form.lat.value), lng: Number(form.lng.value) } : {};
    const res = await pickLocation({ ...current, address: address ? address() : '', near });
    if (res === undefined) return;
    form.lat.value = res ? res.lat : '';
    form.lng.value = res ? res.lng : '';
    show();
  };
}

// Valores do formulário para gravar.
export const pinValues = (form) =>
  form.lat.value !== '' ? { lat: Number(form.lat.value), lng: Number(form.lng.value) } : { lat: null, lng: null };
