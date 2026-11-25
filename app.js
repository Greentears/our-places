import { firebaseConfig } from './firebase-config.js';
import {
  DAYS, PRICE_RANGES, isOpenNow, haversine, walkMinutes, fmtDistance, avgRating, placeFromNominatim, csvCell, nearestCity,
} from './lib.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc,
  onSnapshot, setDoc, addDoc, deleteDoc, getDoc, updateDoc, arrayUnion, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

const DEFAULT_TYPES = ['restaurant', 'brunch', 'bar', 'cocktail bar', 'coffee place', 'bakery', 'street food'];
const DEFAULT_CUISINES = ['italian', 'mexican', 'french', 'japanese', 'chinese', 'indian', 'thai', 'lebanese', 'american', 'fast food', 'vegetarian', 'seafood'];

/* ------------------------------------------------------------------ state */
const S = {
  user: null,
  places: [],
  tags: {},
  filters: { status: 'all', types: new Set(), cuisines: new Set(), price: new Set(), openNow: false, q: '' },
  city: 'all',
  cityChosen: false,
  sort: 'distance',
  view: 'list',
  pos: null,
  ro: false,
  openId: null,
  mode: null, // 'detail' | 'form' | 'filters' | 'menu' | 'share'
  form: null,
  fit: true,
};

/* ------------------------------------------------------------------ firebase */
const configMissing = /^YOUR/.test(firebaseConfig.apiKey || 'YOUR');
let auth, db, unsubPlaces, unsubTags;
if (!configMissing) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  try {
    db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = getFirestore(fbApp);
  }
}

/* ------------------------------------------------------------------ derived data */
const tagUniverse = (kind) => {
  const defaults = kind === 'types' ? DEFAULT_TYPES : DEFAULT_CUISINES;
  const used = S.places.flatMap((p) => p[kind] || []);
  return [...new Set([...defaults, ...(S.tags[kind] || []), ...used])];
};

function distInfo(p) {
  if (!S.pos || p.lat == null || p.lon == null) return null;
  const m = haversine(S.pos, p);
  return { m, txt: fmtDistance(m), walk: m <= 6000 ? `~${walkMinutes(m)} min walk` : '' };
}

function filtered() {
  const f = S.filters;
  const q = f.q.trim().toLowerCase();
  return S.places.filter((p) => {
    if (S.city !== 'all' && p.city !== S.city) return false;
    if (f.status !== 'all' && p.status !== f.status) return false;
    if (f.types.size && !(p.types || []).some((t) => f.types.has(t))) return false;
    if (f.cuisines.size && !(p.cuisines || []).some((t) => f.cuisines.has(t))) return false;
    if (f.price.size && !f.price.has(p.priceLevel)) return false;
    if (f.openNow && isOpenNow(p.hours) !== true) return false;
    if (q) {
      const text = [p.name, p.address, p.city, (p.types || []).join(' '), (p.cuisines || []).join(' '), p.notes].join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
}

function sortPlaces(arr) {
  const ts = (p) => p.createdAt?.toMillis?.() ?? 0;
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const out = [...arr];
  if (S.sort === 'distance' && S.pos) {
    const d = (p) => distInfo(p)?.m ?? Infinity;
    return out.sort((a, b) => d(a) - d(b));
  }
  if (S.sort === 'rating') return out.sort((a, b) => avgRating(b.ratings) - avgRating(a.ratings) || byName(a, b));
  if (S.sort === 'recent') return out.sort((a, b) => ts(b) - ts(a));
  return out.sort(byName);
}

function activeFilterCount() {
  const f = S.filters;
  return (f.status !== 'all') + f.types.size + f.cuisines.size + f.price.size + (f.openNow ? 1 : 0);
}

/* ------------------------------------------------------------------ rendering: list */
function cardHTML(p) {
  const a = avgRating(p.ratings);
  const d = distInfo(p);
  const o = isOpenNow(p.hours);
  return `<article class="card" data-id="${esc(p.id)}">
    <div class="r1"><h3>${esc(p.name)}</h3><span class="rate ${a ? '' : 'none'}">★ ${a ? a.toFixed(1) : '–'}</span></div>
    <div class="meta">${esc([...(p.types || []), ...(p.cuisines || [])].join(' · '))}</div>
    <div class="r3">
      <span class="pill ${p.status === 'visited' ? 'ok' : ''}">${p.status === 'visited' ? 'Visited' : 'Wishlist'}</span>
      ${p.priceLevel ? `<span class="price">${'€'.repeat(p.priceLevel)}</span>` : ''}
      ${o === true ? '<span class="pill open">Open now</span>' : o === false ? '<span class="pill closed">Closed</span>' : ''}
      ${d ? `<span class="dist">${d.txt}${d.walk ? ' · ' + d.walk : ''}</span>` : ''}
    </div>
  </article>`;
}

function renderCities() {
  const counts = {};
  S.places.forEach((p) => { if (p.city) counts[p.city] = (counts[p.city] || 0) + 1; });
  const cities = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  if (S.city !== 'all' && !counts[S.city]) S.city = 'all';
  $('#citySel').innerHTML =
    `<option value="all">All cities (${S.places.length})</option>` +
    cities.map((c) => `<option value="${esc(c)}">${esc(c)} (${counts[c]})</option>`).join('');
  $('#citySel').value = S.city;
}

function renderList() {
  const list = sortPlaces(filtered());
  $('#count').textContent = `${list.length} place${list.length === 1 ? '' : 's'}` +
    (S.sort === 'distance' && !S.pos ? ' · enable location to sort by distance' : '');
  $('#list').innerHTML = list.length
    ? list.map(cardHTML).join('')
    : `<div class="empty">${S.places.length ? 'No place matches these filters.' : S.ro ? 'This list is empty.' : 'No places yet.<br>Tap the + button to add your first one.'}</div>`;
  const n = activeFilterCount();
  $('#fcount').textContent = n;
  $('#fcount').classList.toggle('hidden', !n);
}

function render() {
  renderCities();
  renderList();
  if (S.view === 'map') renderMarkers();
}

/* ------------------------------------------------------------------ map */
let map, mapReady = false, markers = [], meMarker;
function initMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' } },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [4.3517, 50.8503],
    zoom: 11,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => { mapReady = true; renderMarkers(); updateMe(); });
}

function renderMarkers() {
  if (!map || !mapReady) return;
  markers.forEach((m) => m.remove());
  markers = [];
  const list = filtered().filter((p) => p.lat != null && p.lon != null);
  for (const p of list) {
    const a = avgRating(p.ratings);
    const el = document.createElement('div');
    el.className = 'pin ' + (p.status === 'visited' ? '' : 'wish');
    el.innerHTML = `<span>${a ? a.toFixed(1) : '·'}</span>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); openDetail(p.id); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
  }
  if (S.fit && list.length) {
    S.fit = false;
    if (list.length === 1) map.flyTo({ center: [list[0].lon, list[0].lat], zoom: 15 });
    else {
      const b = new maplibregl.LngLatBounds();
      list.forEach((p) => b.extend([p.lon, p.lat]));
      map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 400 });
    }
  }
}

function updateMe() {
  if (!map || !mapReady || !S.pos) return;
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me';
    meMarker = new maplibregl.Marker({ element: el });
  }
  meMarker.setLngLat([S.pos.lon, S.pos.lat]).addTo(map);
}

function showView(v) {
  S.view = v;
  $('#listView').classList.toggle('hidden', v !== 'list');
  $('#mapView').classList.toggle('hidden', v !== 'map');
  $$('nav [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'map') {
    initMap();
    S.fit = true;
    setTimeout(() => { map.resize(); renderMarkers(); updateMe(); }, 30);
  }
}

/* ------------------------------------------------------------------ location */
function locate(userInitiated = false) {
  if (!navigator.geolocation) { if (userInitiated) toast('Location is not available on this device'); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      S.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      maybeAutoCity();
      render();
      updateMe();
      if (userInitiated && map && S.view === 'map') map.flyTo({ center: [S.pos.lon, S.pos.lat], zoom: 15 });
    },
    () => { if (userInitiated) toast('Could not get your location. Check that location access is allowed for this app.', 4500); },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
  );
}

function maybeAutoCity() {
  if (S.cityChosen || !S.pos || !S.places.length) return;
  const c = nearestCity(S.places, S.pos) || 'all';
  if (c !== S.city) { S.city = c; S.fit = true; }
}

/* ------------------------------------------------------------------ bottom sheet */
function openSheet(html, mode) {
  S.mode = mode;
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  S.mode = null;
  S.openId = null;
  S.form = null;
}

/* ------------------------------------------------------------------ detail */
const starRow = (key, label, value, hint = '') => `
  <div class="rrow"><span class="lab">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}</span>
  <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-act="rate" data-k="${key}" data-v="${n}" class="${n <= value ? 'on' : ''}" aria-label="${n} stars">★</button>`).join('')}</div></div>`;

function googleMapsUrl(p) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([p.name, p.address || p.city].filter(Boolean).join(' '));
}

function detailHTML(p, random) {
  const r = p.ratings || {};
  const a = avgRating(r);
  const d = distInfo(p);
  const o = isOpenNow(p.hours);
  const tags = [...(p.types || []), ...(p.cuisines || [])];
  return `
    ${random ? '<div class="banner">🎲 How about this one?</div>' : ''}
    <div id="photoBox" class="photo hidden"></div>
    <div class="dhead"><h2>${esc(p.name)}</h2><div class="avg">★ ${a ? a.toFixed(1) : '–'}</div></div>
    <p class="addr">${esc(p.address || '')}${p.city && !(p.address || '').includes(p.city) ? ' · ' + esc(p.city) : ''}</p>
    <div class="chips">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    <div class="info">
      ${p.priceLevel ? `<span><b>${'€'.repeat(p.priceLevel)}</b> <span class="muted">${PRICE_RANGES[p.priceLevel]} per person</span></span>` : ''}
      ${o === true ? '<span class="pill open">Open now</span>' : o === false ? '<span class="pill closed">Closed now</span>' : ''}
      ${d ? `<span class="muted">${d.txt}${d.walk ? ' · ' + d.walk : ''}</span>` : ''}
    </div>
    <div class="seg edit-only" style="margin-top:8px">
      <button data-act="status" data-v="wishlist" class="${p.status !== 'visited' ? 'on' : ''}">Wishlist</button>
      <button data-act="status" data-v="visited" class="${p.status === 'visited' ? 'on' : ''}">Visited</button>
    </div>
    <label>Our rating</label>
    ${starRow('food', 'Food', r.food || 0)}
    ${starRow('vibe', 'Vibe', r.vibe || 0)}
    ${starRow('value', 'Value for money', r.value || 0, '€')}
    ${p.hours ? `<label>Opening hours</label><div class="muted">${esc(p.hours)}</div>` : ''}
    ${S.ro ? '' : `<label for="notes">Notes</label><textarea id="notes" placeholder="Dishes to try, who recommended it…">${esc(p.notes || '')}</textarea>`}
    <div class="actions">
      <a class="btn block primary" target="_blank" rel="noopener" href="${googleMapsUrl(p)}">Open in Google Maps</a>
      ${random ? '<button class="btn" data-act="again">🎲 Pick another</button>' : ''}
      <div class="actions two edit-only"><button class="btn" data-act="edit">Edit</button><button class="btn danger" data-act="del">Delete</button></div>
    </div>`;
}

function openDetail(id, random = false) {
  const p = S.places.find((x) => x.id === id);
  if (!p) return;
  S.openId = id;
  S.randomMode = random;
  openSheet(detailHTML(p, random), 'detail');
  if (p.hasPhoto && !S.ro) {
    getDoc(doc(db, 'photos', id)).then((s) => {
      if (S.openId !== id || !s.exists()) return;
      const box = $('#photoBox');
      if (box) { box.innerHTML = `<img alt="" src="${s.data().data}">`; box.classList.remove('hidden'); }
    }).catch(() => {});
  }
}

function refreshDetail() {
  if (S.mode !== 'detail' || !S.openId) return;
  if (document.activeElement?.id === 'notes') return;
  const p = S.places.find((x) => x.id === S.openId);
  if (!p) { closeSheet(); return; }
  const scroll = $('#sheetBody').scrollTop;
  openSheet(detailHTML(p, S.randomMode), 'detail');
  $('#sheetBody').scrollTop = scroll;
  if (p.hasPhoto && !S.ro) {
    getDoc(doc(db, 'photos', p.id)).then((s) => {
      const box = $('#photoBox');
      if (s.exists() && box) { box.innerHTML = `<img alt="" src="${s.data().data}">`; box.classList.remove('hidden'); }
    }).catch(() => {});
  }
}

function pickRandom() {
  const list = filtered();
  if (!list.length) { toast('Nothing to pick from. Adjust your filters.'); return; }
  let p = list[Math.floor(Math.random() * list.length)];
  if (list.length > 1 && p.id === S.openId) p = list.find((x) => x.id !== S.openId) || p;
  openDetail(p.id, true);
}

/* ------------------------------------------------------------------ geocoding (Nominatim, free) */
async function geocode(q, limit = 5) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&accept-language=en' +
    `&limit=${limit}&q=${encodeURIComponent(q)}`;
  if (S.pos) {
    const { lat, lon } = S.pos;
    url += `&viewbox=${lon - 0.5},${lat + 0.5},${lon + 0.5},${lat - 0.5}&bounded=0`;
  }
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Address search failed');
  return r.json();
}

/* ------------------------------------------------------------------ add / edit form */
const chipsHTML = (list, selected, kind, withAdd) =>
  list.map((t) => `<button type="button" class="chip ${selected.has(t) ? 'on' : ''}" data-act="${withAdd ? 'chip' : 'fchip'}" data-kind="${kind}" data-t="${esc(t)}">${esc(t)}</button>`).join('') +
  (withAdd ? `<button type="button" class="chip add" data-act="addtag" data-kind="${kind}">+ new</button>` : '');

const priceChips = (current, act) =>
  [1, 2, 3, 4].map((n) => `<button type="button" class="chip ${current.has ? (current.has(n) ? 'on' : '') : (current === n ? 'on' : '')}" data-act="${act}" data-v="${n}" style="text-transform:none">${'€'.repeat(n)} <span style="opacity:.7;font-size:12px">${PRICE_RANGES[n]}</span></button>`).join('');

function formHTML(p) {
  const f = S.form;
  const cities = [...new Set(S.places.map((x) => x.city).filter(Boolean))];
  return `
    <h2>${p ? 'Edit place' : 'Add a place'}</h2>
    <label for="f_search">Find it on the map</label>
    <div class="row"><input id="f_search" type="search" placeholder="Name and city, e.g. Le Perroquet Brussels" enterkeyhint="search"><button class="btn" data-act="find" type="button">Find</button></div>
    <div id="f_results"></div>
    <label for="f_name">Name</label><input id="f_name" value="${esc(p?.name || '')}" autocomplete="off">
    <label for="f_addr">Address</label><input id="f_addr" value="${esc(p?.address || '')}" autocomplete="off">
    <label for="f_city">City</label><input id="f_city" value="${esc(p?.city || '')}" list="cityList" autocomplete="off">
    <datalist id="cityList">${cities.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div id="f_loc" class="hint"></div>
    <label>Type</label><div class="chips" id="f_types">${chipsHTML(tagUniverse('types'), f.types, 'types', true)}</div>
    <label>Cuisine</label><div class="chips" id="f_cuis">${chipsHTML(tagUniverse('cuisines'), f.cuisines, 'cuisines', true)}</div>
    <label>Status</label>
    <div class="seg" id="f_status">
      <button type="button" data-act="fstatus" data-v="wishlist" class="${f.status === 'wishlist' ? 'on' : ''}">Wishlist</button>
      <button type="button" data-act="fstatus" data-v="visited" class="${f.status === 'visited' ? 'on' : ''}">Visited</button>
    </div>
    <label>Price level (per person)</label><div class="chips" id="f_price">${priceChips(f.price, 'fprice')}</div>
    <label for="f_hours">Opening hours <span class="hint">(optional)</span></label>
    <input id="f_hours" value="${esc(p?.hours || '')}" placeholder="Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off" autocomplete="off" autocapitalize="off">
    <div id="f_hint" class="hint"></div>
    <label for="f_notes">Notes</label><textarea id="f_notes" placeholder="Dishes to try, who recommended it…">${esc(p?.notes || '')}</textarea>
    <label for="f_photo">Photo</label>
    <input id="f_photo" type="file" accept="image/*">
    <div class="photoPrev" id="f_prev"></div>
    <div class="actions two">
      <button class="btn" data-act="cancel" type="button">Cancel</button>
      <button class="btn primary" data-act="save" type="button">Save</button>
    </div>`;
}

function openForm(p) {
  S.form = {
    id: p?.id || null,
    lat: p?.lat ?? null,
    lon: p?.lon ?? null,
    types: new Set(p?.types || []),
    cuisines: new Set(p?.cuisines || []),
    status: p?.status || 'wishlist',
    price: p?.priceLevel || 0,
    photo: null,
    rmPhoto: false,
    hasPhoto: !!p?.hasPhoto,
    results: [],
  };
  S.openId = null;
  openSheet(formHTML(p), 'form');
  updateLocHint();
  updateHoursHint();
  if (p?.hasPhoto) {
    getDoc(doc(db, 'photos', p.id)).then((s) => {
      if (S.mode === 'form' && s.exists() && !S.form.photo && !S.form.rmPhoto)
        $('#f_prev').innerHTML = `<img alt="" src="${s.data().data}"><button class="link" data-act="rmphoto" type="button">Remove photo</button>`;
    }).catch(() => {});
  }
}

function updateLocHint() {
  const f = S.form;
  if (!f) return;
  $('#f_loc').textContent = f.lat != null ? '📍 Location found. It will show on the map.' : 'No map location yet. Use “Find”, or it will be looked up from the address when you save.';
}

function updateHoursHint() {
  const v = $('#f_hours')?.value.trim();
  const el = $('#f_hint');
  if (!el) return;
  if (!v) { el.textContent = 'Filled in automatically for many places when you use “Find”. Needed for the “Open now” filter.'; return; }
  const o = isOpenNow(v);
  el.textContent = o === null ? '⚠ Format not recognised. Example: Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off' : o ? '✓ Understood. Open right now.' : '✓ Understood. Closed right now.';
}

async function resizeImage(file, max = 900) {
  const img = await new Promise((res, rej) => {
    const u = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = rej;
    i.src = u;
  });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  let q = 0.75, data = c.toDataURL('image/jpeg', q);
  while (data.length > 700000 && q > 0.3) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
  return data;
}

async function saveForm(btn) {
  const f = S.form;
  const name = $('#f_name').value.trim();
  if (!name) { toast('Give the place a name'); return; }
  const address = $('#f_addr').value.trim();
  let city = $('#f_city').value.trim();
  let { lat, lon } = f;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    if (lat == null && (address || city)) {
      try {
        const r = (await geocode(`${address} ${city}`.trim(), 1))[0];
        if (r) { const x = placeFromNominatim(r); lat = x.lat; lon = x.lon; if (!city) city = x.city; }
      } catch { /* saved without coordinates */ }
    }
    const ref = f.id ? doc(db, 'places', f.id) : doc(collection(db, 'places'));
    const existing = f.id ? S.places.find((p) => p.id === f.id) : null;
    const data = {
      name, address, city,
      lat: lat ?? null, lon: lon ?? null,
      types: [...f.types], cuisines: [...f.cuisines],
      status: f.status, priceLevel: f.price,
      hours: $('#f_hours').value.trim(), notes: $('#f_notes').value.trim(),
      ratings: existing?.ratings || { food: 0, vibe: 0, value: 0 },
      hasPhoto: f.photo ? true : f.rmPhoto ? false : f.hasPhoto,
      updatedAt: serverTimestamp(),
    };
    if (!f.id) { data.createdAt = serverTimestamp(); data.createdBy = S.user?.email || ''; }
    await setDoc(ref, data, { merge: true });
    if (f.photo) await setDoc(doc(db, 'photos', ref.id), { data: f.photo, updatedAt: serverTimestamp() });
    else if (f.rmPhoto) await deleteDoc(doc(db, 'photos', ref.id));
    const isNew = !f.id;
    closeSheet();
    toast(lat == null ? 'Saved, but no map location found. Check the address.' : 'Saved');
    if (isNew) S.fit = true;
  } catch (e) {
    toast('Could not save: ' + (e.message || e));
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function addTag(kind) {
  const label = kind === 'types' ? 'New type of place' : 'New cuisine';
  const t = (prompt(label) || '').trim().toLowerCase();
  if (!t) return;
  try {
    await setDoc(doc(db, 'meta', 'tags'), { [kind]: arrayUnion(t) }, { merge: true });
  } catch (e) { toast('Could not add the tag'); return; }
  S.tags[kind] = [...new Set([...(S.tags[kind] || []), t])];
  S.form[kind].add(t);
  $(kind === 'types' ? '#f_types' : '#f_cuis').innerHTML = chipsHTML(tagUniverse(kind), S.form[kind], kind, true);
}

/* ------------------------------------------------------------------ filters sheet */
function filtersHTML() {
  const f = S.filters;
  return `
    <h2>Filters</h2>
    <label>Status</label>
    <div class="seg">${['all', 'wishlist', 'visited'].map((s) => `<button data-act="fstatusf" data-v="${s}" class="${f.status === s ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <label>Type</label><div class="chips">${chipsHTML(tagUniverse('types'), f.types, 'types', false)}</div>
    <label>Cuisine</label><div class="chips">${chipsHTML(tagUniverse('cuisines'), f.cuisines, 'cuisines', false)}</div>
    <label>Price level</label><div class="chips">${priceChips(f.price, 'fprice2')}</div>
    <label class="toggle"><input type="checkbox" id="fOpen" ${f.openNow ? 'checked' : ''}> Open now only <span class="hint">(places with opening hours)</span></label>
    <label for="sortSel">Sort by</label>
    <select id="sortSel">
      <option value="distance">Distance from me</option><option value="rating">Rating</option>
      <option value="recent">Recently added</option><option value="name">Name</option>
    </select>
    <div class="actions two"><button class="btn" data-act="freset">Reset</button><button class="btn primary" data-act="done">Show ${filtered().length} places</button></div>`;
}
function openFilters() {
  openSheet(filtersHTML(), 'filters');
  $('#sortSel').value = S.sort;
}

/* ------------------------------------------------------------------ menu, export, import, share */
function openMenu() {
  openSheet(`
    <h2>More</h2>
    <p class="muted" style="margin:0">Signed in as ${esc(S.user?.email || '')}</p>
    <div class="menuList">
      <button class="btn" data-act="share">🔗 Share this list (read-only link)</button>
      <button class="btn" data-act="exportjson">⬇ Backup everything (JSON, with photos)</button>
      <button class="btn" data-act="exportcsv">⬇ Export as spreadsheet (CSV)</button>
      <button class="btn" data-act="import">⬆ Import a JSON list</button>
      <button class="btn danger" data-act="signout">Sign out</button>
    </div>`, 'menu');
}

async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const cleanPlace = (p) => ({
  name: p.name, address: p.address || '', city: p.city || '', lat: p.lat ?? null, lon: p.lon ?? null,
  types: p.types || [], cuisines: p.cuisines || [], status: p.status || 'wishlist',
  ratings: { food: p.ratings?.food || 0, vibe: p.ratings?.vibe || 0, value: p.ratings?.value || 0 },
  price_level: p.priceLevel || 0, opening_hours: p.hours || '', notes: p.notes || '',
});

async function exportJSON() {
  toast('Preparing backup…');
  const places = await Promise.all(S.places.map(async (p) => {
    const out = cleanPlace(p);
    if (p.hasPhoto) {
      try { const s = await getDoc(doc(db, 'photos', p.id)); if (s.exists()) out.photo = s.data().data; } catch { /* skip */ }
    }
    return out;
  }));
  await saveFile(`our-places-${stamp()}.json`, JSON.stringify({ app: 'our-places', version: 1, exported: new Date().toISOString(), places }, null, 2), 'application/json');
}

async function exportCSV() {
  const head = ['name', 'address', 'city', 'lat', 'lon', 'types', 'cuisines', 'status', 'food', 'vibe', 'value_for_money', 'average', 'price_level', 'opening_hours', 'notes'];
  const rows = S.places.map((p) => {
    const c = cleanPlace(p);
    return [c.name, c.address, c.city, c.lat, c.lon, c.types.join('; '), c.cuisines.join('; '), c.status, c.ratings.food, c.ratings.vibe, c.ratings.value, avgRating(c.ratings).toFixed(1), c.price_level, c.opening_hours, c.notes];
  });
  await saveFile(`our-places-${stamp()}.csv`, [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('This file is not valid JSON'); return; }
  const arr = Array.isArray(data) ? data : data.places;
  if (!Array.isArray(arr)) { toast('No places found in this file'); return; }
  const key = (p) => `${(p.name || '').trim().toLowerCase()}|${(p.address || '').trim().toLowerCase()}`;
  const have = new Set(S.places.map(key));
  const todo = arr.filter((p) => p && p.name && !have.has(key(p)));
  if (!todo.length) { toast('Nothing new to import'); return; }
  closeSheet();
  let done = 0, located = 0;
  const newTags = { types: new Set(), cuisines: new Set() };
  for (const p of todo) {
    let { lat, lon } = p;
    let city = p.city || '';
    if ((lat == null || lon == null) && (p.address || city)) {
      toast(`Importing ${done + 1}/${todo.length}: looking up addresses…`, 4000);
      try {
        const r = (await geocode(`${p.address || ''} ${city}`.trim(), 1))[0];
        await sleep(1100); // Nominatim usage policy: max 1 request per second
        if (r) { const x = placeFromNominatim(r); lat = x.lat; lon = x.lon; if (!city) city = x.city; }
      } catch { /* keep going */ }
    }
    if (lat != null) located++;
    const types = (p.types || []).map((t) => String(t).toLowerCase());
    const cuisines = (p.cuisines || []).map((t) => String(t).toLowerCase());
    types.forEach((t) => !tagUniverse('types').includes(t) && newTags.types.add(t));
    cuisines.forEach((t) => !tagUniverse('cuisines').includes(t) && newTags.cuisines.add(t));
    const ref = doc(collection(db, 'places'));
    const r = p.ratings || {};
    await setDoc(ref, {
      name: String(p.name), address: p.address || '', city, lat: lat ?? null, lon: lon ?? null,
      types, cuisines, status: p.status === 'visited' ? 'visited' : 'wishlist',
      priceLevel: Number(p.price_level ?? p.priceLevel ?? 0) || 0,
      hours: p.opening_hours || p.hours || '', notes: p.notes || '',
      ratings: { food: r.food || 0, vibe: r.vibe || 0, value: r.value || r.price || 0 },
      hasPhoto: !!p.photo, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: S.user?.email || '',
    });
    if (p.photo) await setDoc(doc(db, 'photos', ref.id), { data: p.photo, updatedAt: serverTimestamp() });
    done++;
  }
  for (const k of ['types', 'cuisines']) {
    if (newTags[k].size) await setDoc(doc(db, 'meta', 'tags'), { [k]: arrayUnion(...newTags[k]) }, { merge: true });
  }
  toast(`Imported ${done} places (${located} with a map location)`, 5000);
}

async function shareList() {
  const list = sortPlaces(filtered());
  if (!list.length) { toast('Nothing to share with the current filters'); return; }
  try {
    const title = (S.city === 'all' ? 'All cities' : S.city) + ` · ${list.length} places`;
    const places = list.map((p) => ({
      name: p.name, address: p.address || '', city: p.city || '', lat: p.lat ?? null, lon: p.lon ?? null,
      types: p.types || [], cuisines: p.cuisines || [], status: p.status || 'wishlist',
      ratings: p.ratings || {}, priceLevel: p.priceLevel || 0, hours: p.hours || '',
    }));
    const ref = await addDoc(collection(db, 'shares'), { title, places, createdAt: serverTimestamp() });
    const url = `${location.origin}${location.pathname}?share=${ref.id}`;
    openSheet(`
      <h2>Link ready</h2>
      <p class="muted">Anyone with this link can see the ${list.length} places currently shown (no notes or photos). It is a snapshot: later changes are not included.</p>
      <input id="shareUrl" value="${esc(url)}" readonly>
      <div class="actions"><button class="btn primary" data-act="copy">Copy link</button><button class="btn" data-act="nativeshare">Share…</button></div>`, 'share');
    S.shareUrl = url;
  } catch (e) { toast('Could not create the link: ' + (e.message || e)); }
}

/* ------------------------------------------------------------------ events */
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
$('#sheetClose').addEventListener('click', closeSheet);

$('#sheetBody').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = S.openId;
  const f = S.form;
  switch (act) {
    /* detail */
    case 'status': await updateDoc(doc(db, 'places', id), { status: el.dataset.v, updatedAt: serverTimestamp() }); break;
    case 'rate': {
      const p = S.places.find((x) => x.id === id);
      const k = el.dataset.k, v = +el.dataset.v;
      const cur = p?.ratings?.[k] || 0;
      await updateDoc(doc(db, 'places', id), { [`ratings.${k}`]: cur === v ? 0 : v, updatedAt: serverTimestamp() });
      break;
    }
    case 'edit': openForm(S.places.find((x) => x.id === id)); break;
    case 'del': {
      const p = S.places.find((x) => x.id === id);
      if (p && confirm(`Delete “${p.name}”?`)) {
        await deleteDoc(doc(db, 'places', id));
        if (p.hasPhoto) deleteDoc(doc(db, 'photos', id)).catch(() => {});
        closeSheet();
      }
      break;
    }
    case 'again': pickRandom(); break;
    /* form */
    case 'chip': {
      const k = el.dataset.kind, t = el.dataset.t;
      f[k].has(t) ? f[k].delete(t) : f[k].add(t);
      el.classList.toggle('on');
      break;
    }
    case 'addtag': addTag(el.dataset.kind); break;
    case 'fstatus': f.status = el.dataset.v; $$('#f_status button').forEach((b) => b.classList.toggle('on', b.dataset.v === f.status)); break;
    case 'fprice': {
      const v = +el.dataset.v;
      f.price = f.price === v ? 0 : v;
      $$('#f_price .chip').forEach((b) => b.classList.toggle('on', +b.dataset.v === f.price));
      break;
    }
    case 'find': {
      const q = $('#f_search').value.trim();
      if (!q) return;
      el.disabled = true;
      $('#f_results').innerHTML = '<div class="hint">Searching…</div>';
      try {
        f.results = await geocode(q, 5);
        $('#f_results').innerHTML = f.results.length
          ? f.results.map((r, i) => `<button type="button" class="res" data-act="pick" data-i="${i}">${esc(r.display_name)}</button>`).join('')
          : '<div class="hint">No result. Try adding the city, or fill in the address by hand.</div>';
      } catch (err) { $('#f_results').innerHTML = `<div class="hint">${esc(err.message)}</div>`; }
      el.disabled = false;
      break;
    }
    case 'pick': {
      const r = f.results[+el.dataset.i];
      const x = placeFromNominatim(r);
      if (!$('#f_name').value.trim() && x.name) $('#f_name').value = x.name;
      $('#f_addr').value = x.address;
      $('#f_city').value = x.city;
      if (x.hours && !$('#f_hours').value.trim()) $('#f_hours').value = x.hours;
      f.lat = x.lat; f.lon = x.lon;
      $('#f_results').innerHTML = '';
      updateLocHint();
      updateHoursHint();
      if (!$('#f_name').value.trim()) $('#f_name').focus();
      break;
    }
    case 'rmphoto': f.photo = null; f.rmPhoto = true; $('#f_prev').innerHTML = ''; break;
    case 'save': await saveForm(el); break;
    case 'cancel': closeSheet(); break;
    /* filters */
    case 'fstatusf': S.filters.status = el.dataset.v; refreshFilters(); break;
    case 'fchip': {
      const set = S.filters[el.dataset.kind], t = el.dataset.t;
      set.has(t) ? set.delete(t) : set.add(t);
      refreshFilters();
      break;
    }
    case 'fprice2': {
      const v = +el.dataset.v;
      S.filters.price.has(v) ? S.filters.price.delete(v) : S.filters.price.add(v);
      refreshFilters();
      break;
    }
    case 'freset':
      S.filters = { ...S.filters, status: 'all', types: new Set(), cuisines: new Set(), price: new Set(), openNow: false };
      refreshFilters();
      break;
    case 'done': closeSheet(); break;
    /* menu */
    case 'share': await shareList(); break;
    case 'exportjson': await exportJSON(); break;
    case 'exportcsv': await exportCSV(); break;
    case 'import': $('#importFile').click(); break;
    case 'signout': closeSheet(); await signOut(auth); break;
    case 'copy':
      try { await navigator.clipboard.writeText(S.shareUrl); toast('Link copied'); } catch { $('#shareUrl').select(); toast('Select and copy the link'); }
      break;
    case 'nativeshare':
      try { await navigator.share({ title: 'Our places', url: S.shareUrl }); } catch { /* cancelled */ }
      break;
  }
});

function refreshFilters() {
  const scroll = $('#sheetBody').scrollTop;
  openSheet(filtersHTML(), 'filters');
  $('#sortSel').value = S.sort;
  $('#sheetBody').scrollTop = scroll;
  render();
}

$('#sheetBody').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'notes' && S.openId) {
    updateDoc(doc(db, 'places', S.openId), { notes: t.value.trim(), updatedAt: serverTimestamp() }).catch(() => toast('Could not save the note'));
  } else if (t.id === 'fOpen') { S.filters.openNow = t.checked; refreshFilters(); }
  else if (t.id === 'sortSel') { S.sort = t.value; render(); }
  else if (t.id === 'f_photo' && t.files[0]) {
    try {
      S.form.photo = await resizeImage(t.files[0]);
      S.form.rmPhoto = false;
      $('#f_prev').innerHTML = `<img alt="" src="${S.form.photo}"><button class="link" data-act="rmphoto" type="button">Remove photo</button>`;
    } catch { toast('Could not read this image'); }
  }
});

$('#sheetBody').addEventListener('input', (e) => {
  if (e.target.id === 'f_hours') updateHoursHint();
  if (e.target.id === 'f_addr' && S.form) { S.form.lat = null; S.form.lon = null; updateLocHint(); }
});
$('#sheetBody').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'f_search') { e.preventDefault(); $('[data-act="find"]').click(); }
});

$('#list').addEventListener('click', (e) => {
  const c = e.target.closest('.card');
  if (c) openDetail(c.dataset.id);
});
$('#citySel').addEventListener('change', (e) => { S.city = e.target.value; S.cityChosen = true; S.fit = true; render(); });
$('#q').addEventListener('input', (e) => { S.filters.q = e.target.value; renderList(); if (S.view === 'map') renderMarkers(); });
$('#filterBtn').addEventListener('click', openFilters);
$('#locBtn').addEventListener('click', () => locate(true));
$('#mapLoc').addEventListener('click', () => { if (S.pos && map) map.flyTo({ center: [S.pos.lon, S.pos.lat], zoom: 15 }); locate(true); });
$('#addBtn').addEventListener('click', () => openForm(null));
$('#randBtn').addEventListener('click', pickRandom);
$('#moreBtn').addEventListener('click', openMenu);
$$('nav [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importJSON(f); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('#app').classList.contains('hidden')) locate(false); });

/* ------------------------------------------------------------------ data flow */
function onData() {
  maybeAutoCity();
  render();
  refreshDetail();
}

function showApp() {
  $('#auth').classList.add('hidden');
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function startApp() {
  showApp();
  unsubPlaces?.();
  unsubTags?.();
  unsubPlaces = onSnapshot(collection(db, 'places'),
    (snap) => { S.places = snap.docs.map((d) => ({ id: d.id, ...d.data() })); onData(); },
    (err) => {
      if (err.code === 'permission-denied') toast('This account is not allowed to read the list. Check the emails in firestore.rules.', 8000);
      else toast('Sync problem: ' + err.message, 6000);
    });
  unsubTags = onSnapshot(doc(db, 'meta', 'tags'), (s) => { S.tags = s.data() || {}; }, () => {});
  locate(false);
}

/* ------------------------------------------------------------------ auth screen */
let signUp = false;
const authMsg = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/email-already-in-use': 'This email already has an account. Sign in instead.',
  'auth/weak-password': 'The password needs at least 6 characters.',
  'auth/invalid-email': 'This email address does not look right.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase yet (see README).',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'No connection.',
};
$('#authToggle').addEventListener('click', () => {
  signUp = !signUp;
  $('#authBtn').textContent = signUp ? 'Create account' : 'Sign in';
  $('#authToggle').textContent = signUp ? 'Already have an account? Sign in' : 'First time? Create the account';
  $('#authPass').autocomplete = signUp ? 'new-password' : 'current-password';
  $('#authErr').textContent = '';
});
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  $('#authBtn').disabled = true;
  try {
    const em = $('#authEmail').value.trim(), pw = $('#authPass').value;
    if (signUp) await createUserWithEmailAndPassword(auth, em, pw);
    else await signInWithEmailAndPassword(auth, em, pw);
  } catch (err) { $('#authErr').textContent = authMsg[err.code] || err.code || 'Something went wrong'; }
  $('#authBtn').disabled = false;
});

/* ------------------------------------------------------------------ boot */
async function bootShare(id) {
  S.ro = true;
  S.sort = 'distance';
  document.body.classList.add('ro');
  try {
    const s = await getDoc(doc(db, 'shares', id));
    if (!s.exists()) throw new Error('missing');
    const d = s.data();
    S.places = (d.places || []).map((p, i) => ({ id: 's' + i, ...p }));
    $('#roBanner').textContent = 'Shared list · ' + (d.title || '');
    $('#roBanner').classList.remove('hidden');
    showApp();
    locate(false);
    onData();
  } catch {
    document.body.innerHTML = '<p class="fatal">This shared list is not available any more.</p>';
  }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

const shareId = new URLSearchParams(location.search).get('share');
if (configMissing) {
  $('#setup').classList.remove('hidden');
} else if (shareId) {
  bootShare(shareId);
} else {
  onAuthStateChanged(auth, (user) => {
    S.user = user;
    if (user) startApp();
    else {
      unsubPlaces?.(); unsubTags?.();
      S.places = [];
      $('#app').classList.add('hidden');
      $('#auth').classList.remove('hidden');
    }
  });
}
