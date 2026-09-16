/* DBZ Money Maker — raw→grade→flip helper.
   OCR via Tesseract.js (on-device). Prices entered manually (eBay live prices
   need a dev key + backend — see EBAY_READY hook below). No backend yet. */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const money = n => (isFinite(n) ? (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2) : '—');
const pct = n => (isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(0) + '%' : '—');

const state = {
  scan: { name: '', code: '' },
  saved: JSON.parse(localStorage.getItem('dbz.saved') || '[]'),
  // Which pack (session) a pending scan should be added to as a pull.
  // Persisted so an iOS reload/crash mid-scan can't detach the pull from its pack.
  pullTarget: (function(){ try { return JSON.parse(localStorage.getItem('dbz.pullTarget') || 'null'); } catch(e){ return null; } })()
};
function save() { localStorage.setItem('dbz.saved', JSON.stringify(state.saved)); }

// Global safety net: if anything throws unexpectedly (e.g. an OCR hiccup),
// surface a readable message and dismiss any stuck loader instead of leaving
// the app looking dead/frozen.
window.addEventListener('error', function(ev){
  try { if (typeof hideLoader === 'function') hideLoader(); } catch(e){}
  try {
    const el = document.querySelector('#ocr-status');
    if (el) { el.classList.remove('hidden'); el.classList.add('err');
      el.textContent = 'Something went wrong — try again, or type the card in manually.'; }
  } catch(e){}
});
window.addEventListener('unhandledrejection', function(){
  try { if (typeof hideLoader === 'function') hideLoader(); } catch(e){}
});
// Persist/clear the active pull target so it survives a page reload or crash.
function setPullTarget(t){
  state.pullTarget = t;
  try {
    if (t) localStorage.setItem('dbz.pullTarget', JSON.stringify(t));
    else localStorage.removeItem('dbz.pullTarget');
  } catch (e) {}
}

/* ---------- Price memory (keyless "automation") ----------
   Remembers the last prices you entered for each card, keyed by name+code+grader.
   Next time you land on that card, the fields auto-fill from memory. Grows with use. */
function memKey(name, code, grader) {
  return (String(name||'').trim().toLowerCase() + '|' + String(code||'').trim().toLowerCase() + '|' + String(grader||'').trim().toLowerCase());
}
function loadMemory() { try { return JSON.parse(localStorage.getItem('dbz.priceMemory') || '{}'); } catch (e) { return {}; } }
function saveMemory(m) { localStorage.setItem('dbz.priceMemory', JSON.stringify(m)); }
// --- UNIFIED PRICE STORE ---
// Market prices (raw + graded) live in ONE place: Collection.recordPrice / latestPrice.
// So a price entered/pulled ANYWHERE (Flip, card refresh, extension) shows EVERYWHERE.
// fee/ship are user settings (not market data) — kept in a tiny side-map by card+grader.
function rememberPrices(name, code, grader, data) {
  const card = Collection.upsertCard({ name, number: code, set:'', variant:'', language:'EN' });
  // record raw price into the shared store
  if (data.raw != null && isFinite(+data.raw) && +data.raw > 0) {
    Collection.recordPrice(card.key, 'ebay', 'RAW', null, +data.raw);
  }
  // record each graded price under this grader (company), kept separate
  if (data.grades) {
    Object.keys(data.grades).forEach(g => {
      const v = +data.grades[g];
      if (isFinite(v) && v > 0) Collection.recordPrice(card.key, 'ebay', grader, g, v);
    });
  }
  // fee/ship side-map (per card+grader) — these are inputs, not market prices
  const m = loadMemory();
  m[memKey(name, code, grader)] = { fee: data.fee, ship: data.ship, when: new Date().toISOString().slice(0,10) };
  saveMemory(m);
}
function recallPrices(name, code, grader) {
  const card = Collection.getCard(Collection.cardKey({ name, number:code, set:'', variant:'', language:'EN' }));
  const side = loadMemory()[memKey(name, code, grader)] || {};
  const key = Collection.cardKey({ name, number:code, set:'', variant:'', language:'EN' });
  const raw = Collection.latestPrice(key, 'ebay', 'RAW', null);
  // pull latest graded prices for this grader
  const grades = {};
  ['10','9.5','9','8'].forEach(g => { const v = Collection.latestPrice(key, 'ebay', grader, g); if (v != null) grades[g] = v; });
  const hasAny = raw != null || Object.keys(grades).length > 0 || side.fee != null || side.ship != null;
  if (!hasAny) return null;
  // "when" = most recent price date we have, else the side-map date
  return { raw, grades, fee: side.fee, ship: side.ship, when: side.when || Collection.today() };
}

/* ---------- reusable loading overlay ----------
   Used for the open splash, OCR reads, and (when wired) eBay price pulls. */
function showLoader(msg) {
  const el = $('#dbz-loading'); if (!el) return;
  if (msg) { const sub = $('#dbz-sub'); if (sub) sub.textContent = msg; }
  el.classList.remove('hidden', 'fading');
}
function hideLoader() {
  const el = $('#dbz-loading'); if (!el) return;
  el.classList.add('fading');
  setTimeout(() => el.classList.add('hidden'), 350);
  hideProgress();
}
// Progress bar (determinate) for long pulls. pct 0-100.
function showProgress(note) {
  const w = $('#dbz-bar-wrap'), n = $('#dbz-note');
  if (w) { w.classList.remove('hidden'); }
  if (n && note) { n.textContent = note; n.classList.remove('hidden'); }
  setProgress(0);
}
function setProgress(pct) {
  const b = $('#dbz-bar'); if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function hideProgress() {
  const w = $('#dbz-bar-wrap'), n = $('#dbz-note');
  if (w) w.classList.add('hidden');
  if (n) n.classList.add('hidden');
  setProgress(0);
}

/* ---------- navigation ---------- */
function showView(v) {
  $$('.pane').forEach(p => p.classList.remove('active'));
  $('#pane-' + v).classList.add('active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $('#view-title').textContent = { scan: 'Scan', collection: 'Collection', carddetail: 'Card', inventory: 'Inventory', business: 'Business' }[v] || 'DBZ';
  if (v === 'collection') renderCollection();
  if (v === 'inventory') renderInventory();
  if (v === 'business') renderProducts();
  renderVerifyBadge();
}

/* ---------- camera + OCR ---------- */
let stream = null;
async function startCam() {
  try {
    // Request a MODERATE resolution back camera + continuous autofocus.
    // NOTE: 4K (3840x2160 ~= 33MP) frames caused iOS to kill the PWA tab on
    // capture (out-of-memory). 1080p is plenty for the card-number OCR and is
    // far lighter on memory, so capture no longer crashes.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        focusMode: 'continuous'
      }
    }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }));
    const v = $('#cam'); v.srcObject = stream; await v.play();
    // Best-effort: apply continuous focus + a modest zoom on devices that support it.
    // Many iOS versions ignore these — that's fine, we just try.
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const adv = [];
      if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
      if (caps.zoom && caps.zoom.max) {
        const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, 2)); // ~2x if allowed
        adv.push({ zoom: z });
      }
      if (adv.length) await track.applyConstraints({ advanced: adv });
    } catch (e) { /* zoom/focus not supported on this device — ignore */ }
    $('#cam-wrap').classList.remove('hidden');
    $('#capture-btn').classList.remove('hidden');
    const btn = $('[data-action="start-cam"]'); if (btn) btn.textContent = '✕ Close Camera';
  } catch (e) {
    ocrStatus('Camera unavailable — use "Upload a photo" instead.', true);
  }
}
function stopCam() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('#cam-wrap').classList.add('hidden');
  $('#capture-btn').classList.add('hidden');
  const btn = $('[data-action="start-cam"]'); if (btn) btn.textContent = '📷 Open Camera';
}
// tapping the camera button toggles it open/closed
function toggleCam() { if (stream) stopCam(); else startCam(); }

function ocrStatus(msg, err) {
  const el = $('#ocr-status'); el.classList.remove('hidden');
  el.textContent = msg; el.classList.toggle('err', !!err);
}

async function captureFromVideo() {
  const v = $('#cam'); if (!v.videoWidth) { ocrStatus('Camera not ready yet.', true); return; }
  // Cap the captured frame size. A very large frame (e.g. 4K) can spike memory
  // enough for iOS to kill the tab mid-scan. 1600px on the long edge is more
  // than enough resolution for the card-number OCR.
  const MAX_EDGE = 1600;
  const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight));
  const c = $('#cap-canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  await runOcr(c);
}

async function ocrFromFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = async () => {
    try {
      // Cap the source size before drawing. Library photos are often 12MP+
      // (e.g. 4032x3024) which can spike memory enough for iOS to kill the tab.
      // 1600px on the long edge is plenty for the card-number OCR.
      const MAX_EDGE = 1600;
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = $('#cap-canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      await runOcr(c);
    } catch (e) {
      ocrStatus('Could not read that photo. Try a clearer one or type the card in manually.', true);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    ocrStatus('Could not open that photo. Try a different image.', true);
  };
  img.src = url;
}

/* Read only two regions: top strip (name) and bottom-right (card code). Faster + more accurate. */
// Shrink a canvas to a small JPEG thumbnail (data URL) so it's tiny in storage (~15KB).
function makeThumb(canvas, maxW){
  try {
    maxW = maxW || 160;
    const scale = Math.min(1, maxW / canvas.width);
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    t.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return t.toDataURL('image/jpeg', 0.7);
  } catch (e) { return ''; }
}
// Load an image URL into a compact stored thumbnail (data URL). Needs the host to
// allow cross-origin image use; returns '' on any failure (offline, blocked, 404).
function urlToThumb(url){
  return new Promise(resolve=>{
    if (!url) return resolve('');
    const img = new Image();
    img.crossOrigin = 'anonymous';   // needed to read pixels into a canvas
    img.onload = ()=>{
      try { const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
        c.getContext('2d').drawImage(img,0,0); resolve(makeThumb(c, 300)); }   // 300px = crisp but small
      catch(e){ resolve(''); }
    };
    img.onerror = ()=>resolve('');
    img.src = url;
  });
}
// Fetch + cache the official card image ONCE onto a card (by cardKey), if it doesn't
// already have one. After success the image is stored locally (offline, no refetch).
async function cacheCardImage(cardKey, number){
  try {
    if (!window.CardDB || !window.Collection) return;
    const card = Collection.getCard(cardKey); if (!card) return;
    // Prefer the crisp OFFICIAL image. Fetch it once (even if a scan photo exists),
    // then never refetch (officialImage flag marks it done).
    if (card.officialImage) return;
    if (_imgTried[cardKey]) return;          // already tried this session — wait till next open
    _imgTried[cardKey] = 1;
    const url = CardDB.imageUrl(number || card.number); if (!url) return;
    const thumb = await urlToThumb(url);
    if (thumb) {
      // got the official image → use it (overrides scan photo), mark done permanently
      Collection.upsertCard({ name:card.name, number:card.number, set:card.set,
        variant:card.variant, rarity:card.rarity, language:card.language, image:thumb,
        officialImage:true, dbVerified:card.dbVerified }); renderInventory();
    }
    // on failure: do NOT set officialImage — it'll retry on the next app open (maybe online then).
  } catch(e){}
}
const _imgTried = {};

// Read an image FILE into a small thumbnail data URL (for manual "add photo").
function fileToThumb(file){
  return new Promise(resolve=>{
    const img = new Image();
    img.onload = ()=>{ const c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight; c.getContext('2d').drawImage(img,0,0); resolve(makeThumb(c)); };
    img.onerror = ()=>resolve('');
    img.src = URL.createObjectURL(file);
  });
}
async function runOcr(canvas) {
  if (typeof Tesseract === 'undefined') { ocrStatus('OCR engine still loading — try again in a second.', true); return; }
  if (typeof Scanner === 'undefined') { ocrStatus('Scanner module not loaded — refresh and try again.', true); return; }
  ocrStatus('Reading card…');
  showLoader('Reading card…');
  // capture a thumbnail of the scanned card so it can be saved as the card's image
  state.scan = state.scan || {};
  const thumb = makeThumb(canvas);
  try {
    const result = await Scanner.scan(canvas);
    result.image = thumb;
    if (!result.detected) {
      ocrStatus('⚠️ No card clearly detected — center the card on a plain background and try again. (Read anyway below.)', true);
    }
    // Preserve the FULL structured scan result (raw OCR included) for verification.
    state.scanResult = result;
    // Back-compat: keep the simple fields the rest of the app already uses.
    state.scan = { name: result.name, code: result.cardNumber, image: thumb };
    // Fill the editable fields (user can fix misreads before adding).
    $('#f-name').value = result.name || '';
    $('#f-code').value = result.cardNumber || '';
    renderScanResult(result);
    $('#scan-result').classList.remove('hidden');
    ocrStatus('Done — review the identification below and fix anything before adding.');
    stopCam(); $('#cam-wrap').classList.add('hidden'); $('#capture-btn').classList.add('hidden');
  } catch (e) {
    ocrStatus('Could not read the card. Try better lighting or type it in manually below.', true);
    $('#scan-result').classList.remove('hidden');
  } finally {
    hideLoader();
  }
}
function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

// Fetch + load the full card database from the user's device (one-time, then offline).
async function loadCardDbUI(){
  if (!window.CardDB || !CardDB.fetchAndLoad) { alert('Card DB module not loaded.'); return; }
  const st = $('#carddb-status');
  const set = m => { if (st) st.textContent = m; };
  set('Loading card database… (needs internet this one time)');
  try {
    const n = await CardDB.fetchAndLoad(set);
    if (n > 0) set(`✓ Loaded ${n} cards. Scanner can now identify cards by number — works offline.`);
    else set('⚠ Could not load (the card API may block browser requests). Your scanned cards still self-learn.');
  } catch (e) {
    set('⚠ Load failed: ' + e.message + '. Self-learning still works.');
  }
}

// ---- Verify-against-database: cards not yet confirmed vs the card DB ----
// A card "needs verifying" if it hasn't been marked dbVerified. Only meaningful
// when a card DB is loaded (otherwise nothing to verify against).
function unverifiedCards(){
  try {
    if (!window.Collection || !Collection.allCards) return [];
    const dbReady = window.CardDB && CardDB.count && CardDB.count() > 0;
    if (!dbReady) return [];
    return Object.values(Collection.allCards() || {}).filter(c => c && !c.dbVerified && c.number);
  } catch (e) { return []; }
}
function renderVerifyBadge(){
  const b = $('#verify-badge'); if (!b) return;
  const n = unverifiedCards().length;
  const cnt = $('#verify-badge-count'); if (cnt) cnt.textContent = n;
  b.classList.toggle('hidden', n === 0);
}
function openVerifyList(){
  renderVerifyList();
  const s = $('#verify-list-screen'); if (s) s.classList.remove('hidden');
}
function renderVerifyList(){
  const el = $('#verify-list'); if (!el) return;
  const cards = unverifiedCards();
  if (!cards.length) { el.innerHTML = '<p class="hint">✓ All cards verified.</p>'; return; }
  el.innerHTML = cards.map(c => {
    const variants = (window.CardDB && CardDB.variantsOf) ? CardDB.variantsOf(c.number) : [];
    const opts = variants.map((v,i) =>
      `<button class="btn-secondary block sc-alt-btn" data-action="verify-pick" data-key="${escapeHtmlSafe(c.key)}" data-num="${escapeHtmlSafe(v.number)}" data-rarity="${escapeHtmlSafe(v.rarity||'')}">${escapeHtmlSafe(v.number)} · ${escapeHtmlSafe(v.rarity||'?')}${/★/.test(v.rarity||'')?' ⭐':''}${/SPR|SCR|SLR/.test(v.rarity||'')?' (alt art)':''}</button>`
    ).join('');
    return `<div class="inv-item" style="margin-bottom:8px">
      <div class="inv-item-name">${escapeHtmlSafe(c.name||c.number)} <span class="muted">${escapeHtmlSafe(c.number)}</span></div>
      <div class="hint" style="margin:2px 0">Pick the exact printing you own:</div>
      ${opts || '<div class="hint">No database match for this number.</div>'}
      <button class="btn-secondary block sc-alt-btn" data-action="verify-pick" data-key="${escapeHtmlSafe(c.key)}" data-num="${escapeHtmlSafe(c.number)}" data-rarity="${escapeHtmlSafe(c.rarity||'')}" style="opacity:.7">Keep as-is (mark verified)</button>
    </div>`;
  }).join('');
}
// Confirm a printing for a pre-existing card: set rarity/variant, mark verified.
function verifyPickCard(el){
  if (!el || !el.dataset || !window.Collection) return;
  const key = el.dataset.key, num = el.dataset.num, rarity = el.dataset.rarity || '';
  const card = Collection.getCard(key); if (!card) return;
  const isStar = /★/.test(rarity);
  const isAlt = /SPR|SCR|SLR/.test(rarity) || isStar;
  const variant = isStar ? 'Star / Alt Art' : (/SPR|SCR|SLR/.test(rarity) ? 'Alt Art' : (card.variant||''));
  // renameCard handles re-keying if the number changed; otherwise upsert merges.
  if (num && num.toUpperCase() !== (card.number||'').toUpperCase() && Collection.renameCard) {
    Collection.renameCard(key, { name: card.name, number: num });
  }
  const newKey = (window.Collection && Collection.cardKey) ? Collection.cardKey({ name: card.name, number: num || card.number }) : key;
  Collection.upsertCard({ name: card.name, number: num || card.number, set: card.set,
    rarity: rarity || card.rarity, variant, language: card.language || 'EN',
    image: '', officialImage: false, dbVerified: true });   // clear old photo → official image will load
  // fetch the crisp official image now that we have a confirmed number
  if ((num || card.number)) cacheCardImage(newKey, num || card.number);
  renderVerifyList(); renderVerifyBadge(); renderInventory();
}

// ---- TEST: seed 5 real cards (for image testing) ----
function seedTestCards(){
  if (!window.Collection) return;
  const tests = [
    { name:'Son Gohan: Youth', number:'FB05-054', set:'FB05', rarity:'SR' },
    { name:'King Cold', number:'FB05-073', set:'FB05', rarity:'R' },
    { name:'Son Gohan: Childhood', number:'SB02-008', set:'SB02', rarity:'SR' },
    { name:'Vegeta', number:'ST01-053', set:'ST01', rarity:'C' },
    { name:'SSG Trunks, Power Awakened', number:'BT16-107', set:'BT16', rarity:'SR' }
  ];
  tests.forEach(t => {
    const card = Collection.upsertCard({ name:t.name, number:t.number, set:t.set, rarity:t.rarity, language:'EN', dbVerified:true });
    const it = Collection.addItem(card.key, { condition:'raw', qty:1, valSource:'ebay' });
    Collection.updateItem(it.id, { status:'in_inventory', acq:{ price:1, shipping:0, tax:0, other:0, date:Collection.today() } });
  });
  renderInventory();
  alert('Added 5 test cards with real numbers. Check the Inventory tab for their images.');
}

// ---- Image diagnostic: reports why card images may not be loading ----
function runImageDiag(){
  const out = $('#img-diag-out'); if (!out) return;
  const L = [];
  L.push('=== IMAGE DIAGNOSTIC ===');
  L.push('app version: ' + (window.APP_VERSION||'?'));
  L.push('page URL: ' + location.origin);
  L.push('modules → CardDB:' + (window.CardDB?'Y':'N') + ' Scanner:' + (window.Scanner?'Y':'N') + ' Collection:' + (window.Collection?'Y':'N') + ' Products:' + (window.Products?'Y':'N'));
  L.push('CARD_DB_BUNDLED present: ' + (window.CARD_DB_BUNDLED ? Object.keys(window.CARD_DB_BUNDLED).length + ' cards' : 'NO'));
  L.push('CardDB loaded: ' + (window.CardDB ? 'yes' : 'NO') + ' · count: ' + (window.CardDB && CardDB.count ? CardDB.count() : 'n/a'));
  L.push('online: ' + (navigator.onLine ? 'yes' : 'NO'));
  L.push('service worker: ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'active' : 'none'));
  // sample cards from YOUR inventory (up to 3) + one known test card
  const owned = (window.Collection && Collection.allCards) ? Object.values(Collection.allCards()||{}) : [];
  const samples = [];
  owned.slice(0,3).forEach(c => samples.push({ label:'owned', number:c.number, name:c.name, hasImg:!!c.image }));
  samples.push({ label:'test', number:'FB05-054', name:'Son Gohan: Youth', hasImg:false });
  L.push('owned cards: ' + owned.length + ' · with a number: ' + owned.filter(c=>c.number).length);
  // Show what the thumbnail renderer actually produces for the first few owned cards
  L.push('--- thumbnail render check ---');
  owned.slice(0,4).forEach(c=>{
    let html=''; try { html = cardThumbHtml(c); } catch(e){ html='ERROR: '+e.message; }
    const kind = html.startsWith('<img') ? 'IMG('+((html.match(/src="([^"]*)"/)||[])[1]||'').slice(0,50)+'…)' : (html.length<4?'PLACEHOLDER':html.slice(0,40));
    L.push('  '+(c.name||c.number||'?')+' [num='+(c.number||'none')+'] → '+kind);
  });
  out.textContent = L.join('\n') + '\n\nTesting image URLs…';
  // test each sample URL by actually trying to load it
  let pending = 0;
  const results = [];
  samples.forEach((s, i) => {
    if (!s.number) { results[i] = `  [${s.label}] "${s.name||'?'}" — NO NUMBER (can't build URL)`; return; }
    const url = (window.CardDB && CardDB.imageUrl) ? CardDB.imageUrl(s.number) : '';
    if (!url) { results[i] = `  [${s.label}] ${s.number} — no URL built`; return; }
    pending++;
    const img = new Image();
    const t0 = Date.now();
    const finish = (status) => { results[i] = `  [${s.label}] ${s.number} → ${status} (${Date.now()-t0}ms)\n      ${url}`; pending--; if (pending<=0) render(); };
    img.onload = () => finish('✓ LOADED ' + img.naturalWidth + 'x' + img.naturalHeight);
    img.onerror = () => finish('✕ FAILED (blocked/404)');
    setTimeout(() => { if (results[i]===undefined) finish('⏳ TIMED OUT (host hung)'); }, 6000);
    img.src = url;
  });
  function render(){ out.textContent = L.join('\n') + '\n\n' + results.filter(Boolean).join('\n') + domReport() + '\n\n(screenshot this and send it)'; }
  if (pending===0) render();
  else out.textContent = L.join('\n') + '\n\nTesting ' + pending + ' image URL(s)… wait ~6s';
}
// Inspect the ACTUAL rendered inventory DOM on the device.
function domReport(){
  try {
    const thumbs = document.querySelectorAll('#inv-list .inv-thumb');
    const imgs = document.querySelectorAll('#inv-list .inv-thumb img');
    let r = '\n\n--- LIVE DOM (rendered inventory) ---';
    r += '\n.inv-thumb containers: ' + thumbs.length;
    r += '\n.inv-thumb <img> tags: ' + imgs.length;
    if (imgs.length) {
      const im = imgs[0];
      const cs = getComputedStyle(im);
      const box = im.getBoundingClientRect();
      r += '\nfirst img src: ' + (im.getAttribute('src')||'').slice(0,60);
      r += '\nfirst img complete: ' + im.complete + ' · naturalW: ' + im.naturalWidth;
      r += '\nfirst img display: ' + cs.display + ' · visibility: ' + cs.visibility + ' · opacity: ' + cs.opacity;
      r += '\nfirst img box: ' + Math.round(box.width) + 'x' + Math.round(box.height);
      const tcs = getComputedStyle(thumbs[0]);
      r += '\nthumb container display: ' + tcs.display + ' · size: ' + Math.round(thumbs[0].getBoundingClientRect().width)+'x'+Math.round(thumbs[0].getBoundingClientRect().height);
    } else if (thumbs.length) {
      r += '\nfirst thumb innerHTML: ' + (thumbs[0].innerHTML||'').slice(0,80);
    }
    return r;
  } catch(e){ return '\n\nDOM report error: ' + e.message; }
}

// Open the verification screen, pre-filled from the scanner result (or the edited fields).
function openVerifyScreen(){
  const r = state.scanResult || {};
  // start from the (possibly user-edited) quick fields, fall back to scan result
  const name = ($('#f-name') && $('#f-name').value.trim()) || r.name || '';
  const number = ($('#f-code') && $('#f-code').value.trim()) || r.cardNumber || '';
  if ($('#verify-name'))     $('#verify-name').value = name;
  if ($('#verify-number'))   $('#verify-number').value = number;
  if ($('#verify-set'))      $('#verify-set').value = r.set || '';
  if ($('#verify-rarity'))   $('#verify-rarity').value = r.rarity || '';
  if ($('#verify-variant'))  $('#verify-variant').value = (r.variant || '');
  // Star variant detected → prompt to confirm 1★ vs 2★ (OCR can't count reliably).
  if (r.starVariant && $('#verify-variant')) {
    const pick = prompt('⭐ This looks like a STAR variant (alt art).\n\nHow many stars? Type 1 or 2 (or leave blank to decide later):', '1');
    if (pick === '1') $('#verify-variant').value = '1★ (Star / Alt Art)';
    else if (pick === '2') $('#verify-variant').value = '2★ (Star / Alt Art)';
    else $('#verify-variant').value = 'Star / Alt Art (verify ★ count)';
  }
  if ($('#verify-language')) $('#verify-language').value = 'EN';
  if ($('#verify-qty')) $('#verify-qty').value = '1';
  const thumb = (state.scan && state.scan.image) || (r.image) || '';
  if ($('#verify-thumb')) $('#verify-thumb').innerHTML = thumb ? `<img src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : '🃏';
  // reuse the identification panel at the top of the verify sheet
  const idEl = $('#verify-ident');
  if (idEl && r.rawOcr) { const tmp = $('#scan-ident'); renderScanResult(r); if (tmp) idEl.innerHTML = tmp.innerHTML; }
  else if (idEl) idEl.innerHTML = '';
  $('#verify-screen').classList.remove('hidden');
}

// Confirm the verified card: record OCR corrections (learning), then commit via the
// EXISTING inventory path (upsertCard/addItem) — financial logic untouched.
function confirmVerifiedCard(dest){
  const name = ($('#verify-name').value || '').trim();
  const number = ($('#verify-number').value || '').trim();
  if (!name) { alert('Enter a card name.'); return; }
  const set = ($('#verify-set').value || '').trim();
  const rarity = ($('#verify-rarity').value || '').trim();
  const variant = ($('#verify-variant').value || '').trim();
  const language = ($('#verify-language').value || 'EN').trim() || 'EN';
  // --- error learning: compare raw OCR to the confirmed values ---
  const r = state.scanResult;
  if (r && window.Scanner) {
    try {
      if (r.cardNumberRaw && number) Scanner.learnCorrection('number', r.cardNumberRaw, number);
      if (r.nameRaw && name)         Scanner.learnCorrection('name', r.nameRaw, name);
    } catch (e) {}
  }
  // --- card knowledge base: remember number -> {name,set,rarity,variant} ---
  if (number && window.CardDB) {
    try { CardDB.learn(number, { name, set, rarity, variant }); } catch (e) {}
  }
  const image = (state.scan && state.scan.image) || (r && r.image) || '';
  const qty = Math.max(1, parseInt(($('#verify-qty') && $('#verify-qty').value) || '1', 10) || 1);
  // --- If this scan is for a PACK PULL, add it as a pull and return to Business ---
  if (state.pullTarget && state.pullTarget.sessionId) {
    const sid = state.pullTarget.sessionId;
    for (let i=0;i<qty;i++) addPullCard(sid, { name, number, set, variant, rarity, language, image, dbVerified: true });
    setPullTarget(null);
    $('#verify-screen').classList.add('hidden');
    $('#scan-result').classList.add('hidden');
    if (confirm(`✓ Added ${qty>1?qty+'× ':''}${name} as a pull.\n\nScan another pull?`)) {
      // re-target the same session for the next scan
      setPullTarget({ sessionId: sid });
      resetScanForNext();
      showView('scan');
    } else {
      showView('business');
    }
    return;
  }
  // EXISTING inventory path — do not change cost/accounting logic
  const card = Collection.upsertCard({ name, number, set, variant, rarity, language, image, dbVerified: true });
  // Prefer the crisp official image over the scan photo: fetch + cache it (once).
  if (number) cacheCardImage(card.key, number);
  $('#verify-screen').classList.add('hidden');
  $('#scan-result').classList.add('hidden');
  if (dest === 'collection') {
    const it = Collection.addItem(card.key, { condition:'raw', qty });
    currentCardKey = card.key;
    showView('carddetail');
  } else {
    const it = Collection.addItem(card.key, { condition:'raw', qty, valSource:'ebay' });
    Collection.updateItem(it.id, { status:'in_inventory', acq:{ price:0, shipping:0, tax:0, other:0, date:Collection.today() } });
    // Rapid rip loop: offer to scan the next card immediately.
    if (confirm(`✓ Added ${qty>1?qty+'× ':''}${name}.\n\nScan another card?`)) {
      resetScanForNext();
      showView('scan');
    } else {
      showView('inventory');
      openInvEditor(it.id);
    }
  }
}

// Clear scan state so the next scan starts fresh (rip-loop helper).
function resetScanForNext(){
  state.scan = {};
  state.scanResult = null;
  if ($('#f-name')) $('#f-name').value = '';
  if ($('#f-code')) $('#f-code').value = '';
  if ($('#scan-ident')) $('#scan-ident').innerHTML = '';
  if ($('#scan-result')) $('#scan-result').classList.add('hidden');
  const os = $('#ocr-status'); if (os) { os.classList.add('hidden'); os.textContent = ''; }
}

// Render the structured scanner identification into #scan-ident (verification prep).
function renderScanResult(r){
  const el = $('#scan-ident'); if (!el) return;
  const pct = x => Math.round((x||0)*100) + '%';
  const conf = c => `<span class="sc-conf sc-${c>=0.8?'hi':c>=0.5?'mid':'lo'}">${pct(c)}</span>`;
  const flag = v => v ? escapeHtmlSafe(v) : '<span class="sc-verify">Unknown — Verify</span>';
  let html = `<div class="sc-box">`;
  if (r.dbMatched) {
    html += `<div class="sc-match sc-match-ok">✓ Known card (from your card database): <b>${escapeHtmlSafe((r.dbCard&&r.dbCard.name)||r.name)}</b> ${escapeHtmlSafe(r.cardNumber)}</div>`;
  }
  html += `<div class="sc-row"><span>Overall confidence</span>${conf(r.confidence.overall)}</div>`;
  html += `<div class="sc-grid">`;
  html += `<div class="sc-cell"><div class="sc-lbl">Name ${conf(r.confidence.name)}</div><div>${flag(r.name)}</div></div>`;
  html += `<div class="sc-cell"><div class="sc-lbl">Card # ${conf(r.confidence.number)}</div><div>${flag(r.cardNumber)}${r.cardNumber&&!r.cardNumberValid?' <span class="sc-verify">?</span>':''}</div></div>`;
  html += `<div class="sc-cell"><div class="sc-lbl">Set ${conf(r.confidence.set)}</div><div>${flag(r.set)}</div></div>`;
  html += `<div class="sc-cell"><div class="sc-lbl">Rarity ${conf(r.confidence.rarity)}</div><div>${flag(r.rarity)}</div></div>`;
  html += `<div class="sc-cell"><div class="sc-lbl">Variant ${conf(r.confidence.variant)}</div><div>${r.variant?escapeHtmlSafe(r.variant):('<span class="sc-verify">'+escapeHtmlSafe(r.altArt||'Unknown — Verify')+'</span>')}</div></div>`;
  html += `</div>`;
  // match / alternatives
  if (r.match) {
    html += `<div class="sc-match ${r.needsVerification?'sc-match-verify':'sc-match-ok'}">${r.needsVerification?'⚠️ Best guess':'✓ Matched'}: <b>${escapeHtmlSafe(r.match.name)}</b> ${escapeHtmlSafe(r.match.number||'')} <span class="muted">(${r.matchWhy.join(', ')})</span></div>`;
  } else {
    html += `<div class="sc-match sc-match-verify">No match in your cards — this looks new. Verify the details, then add it.</div>`;
  }
  if (r.alternativeMatches && r.alternativeMatches.length) {
    html += `<div class="sc-alts">Other possible matches:</div>`;
    r.alternativeMatches.forEach((a,i)=>{
      html += `<button class="btn-secondary block sc-alt-btn" data-action="scan-pick-alt" data-idx="${i}">${escapeHtmlSafe(a.card.name)} ${escapeHtmlSafe(a.card.number||'')}</button>`;
    });
  }
  // raw OCR (collapsed, for transparency — never overwritten)
  html += `<details class="sc-raw"><summary>Raw OCR (unedited)</summary><pre>name: ${escapeHtmlSafe(r.rawOcr.name)}\nnumber: ${escapeHtmlSafe(r.rawOcr.number)}\nbottom: ${escapeHtmlSafe(r.rawOcr.bottom)}</pre></details>`;
  html += `</div>`;
  el.innerHTML = html;
}

function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}
function cleanName(t) {
  return (t || '').replace(/\n+/g, ' ').replace(/[^A-Za-z0-9 '\-!.&]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function cleanCode(t) {
  // card codes look like BT1-001, P-001, EB1-045, SD1-01, etc.
  const m = (t || '').toUpperCase().match(/[A-Z]{1,4}[0-9]{0,3}-[0-9]{1,4}[A-Z]?/);
  if (m) return m[0];
  return (t || '').replace(/\n+/g, ' ').replace(/[^A-Z0-9\- ]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

/* ---------- eBay search links (works today, no API) ---------- */
function ebaySearchUrl(query, graded) {
  const q = encodeURIComponent(query + (graded ? ' ' + graded : ''));
  // _sop=15 sorts by price+shipping lowest; LH_BIN=1 = Buy It Now only
  return `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_BIN=1&_sop=15`;
}
/* Grade tiers per grader — note PSA has NO 9.5 (whole numbers); 9.5 is CGC/BGS.
   services[] = grading service levels with an approx fee (EDITABLE in the app).
   NOTE: these fees are starting defaults — verify current pricing on each grader's
   site (beckett.com/grading, psacard.com, cgccards.com) and edit as needed. */
const GRADERS = {
  BGS: { name: 'BGS (Beckett)', grades: ['10', '9.5', '9', '8.5'], services: [
    { label: 'Base, no subgrades (75+ biz days)', fee: 14.95 },
    { label: 'Base, with subgrades (75+ biz days)', fee: 17.95 },
    { label: 'Standard (45 biz days)',  fee: 34.95 },
    { label: 'Express (15 biz days)',   fee: 79.95 },
    { label: 'Priority (5 biz days)',   fee: 124.95 }
  ]},
  PSA: { name: 'PSA', grades: ['10', '9', '8'], services: [
    { label: 'Value (bulk)',    fee: 19 },
    { label: 'Regular',         fee: 75 },
    { label: 'Express',         fee: 150 },
    { label: 'Super Express',   fee: 300 }
  ]},
  CGC: { name: 'CGC', grades: ['10', '9.5', '9', '8'], services: [
    { label: 'Economy',   fee: 18 },
    { label: 'Standard',  fee: 30 },
    { label: 'Express',   fee: 65 },
    { label: 'Premium',   fee: 150 }
  ]}
};
function buildEbayLinks() {
  const q = [state.scan.name, state.scan.code].filter(Boolean).join(' ').trim() || 'dragon ball card';
  let html = `<a class="ebay-link" href="${ebaySearchUrl(q, '')}" target="_blank" rel="noopener">Search eBay — <b>Raw (ungraded)</b> ↗</a>`;
  Object.values(GRADERS).forEach(gr => {
    html += `<div class="ebay-group"><div class="ebay-group-title">${esc(gr.name)}</div>`;
    gr.grades.forEach(g => {
      const term = `${gr.name.split(' ')[0]} ${g}`; // "PSA 10", "CGC 9.5", "BGS 9.5"
      html += `<a class="ebay-link" href="${ebaySearchUrl(q, term)}" target="_blank" rel="noopener">${esc(gr.name.split(' ')[0])} ${esc(g)} ↗</a>`;
    });
    html += `</div>`;
  });
  $('#ebay-links').innerHTML = html;
}

/* ---------- flip calculator ---------- */
function num(id) { const v = parseFloat($(id).value); return isFinite(v) ? v : 0; }

// render the grade price inputs + service options for the selected grader
function renderGradeInputs() {
  const key = $('#grader-select').value;
  const gr = GRADERS[key];
  const label = gr.name.split(' ')[0];
  $('#grade-inputs').innerHTML = gr.grades.map(g =>
    `<label class="field"><span>${esc(label)} ${esc(g)} $</span><input type="number" class="grade-price" data-grade="${esc(g)}" inputmode="decimal" step="0.01" placeholder="0.00" /></label>`
  ).join('');
  // populate the grading-service dropdown for this grader
  const svc = $('#service-select');
  svc.innerHTML = gr.services.map((s, i) => `<option value="${i}">${esc(s.label)} — $${s.fee}</option>`).join('');
  applyServiceFee(); // auto-fill fee from the (default) selected service
  prefillFromMemory(); // auto-fill prices if this card was priced before
}
// auto-fill the grading fee from the selected service tier
function applyServiceFee() {
  const gr = GRADERS[$('#grader-select').value];
  const idx = parseInt($('#service-select').value) || 0;
  const svc = gr.services[idx];
  if (svc) $('#p-fee').value = svc.fee;
}
// pull remembered prices for this card+grader into the fields
function prefillFromMemory() {
  const label = GRADERS[$('#grader-select').value].name.split(' ')[0];
  const mem = recallPrices(state.scan.name, state.scan.code, label);
  const note = $('#mem-note');
  if (!mem) { if (note) note.classList.add('hidden'); return; }
  if (mem.raw != null) $('#p-raw').value = mem.raw;
  if (mem.ship != null) $('#p-ship').value = mem.ship;
  if (mem.fee != null) $('#p-fee').value = mem.fee;
  if (mem.grades) {
    $$('.grade-price').forEach(inp => { const v = mem.grades[inp.dataset.grade]; if (v != null) inp.value = v; });
  }
  if (note) { note.textContent = `↻ Auto-filled from your last entry (${mem.when}). Edit if prices changed.`; note.classList.remove('hidden'); }
}

function calcFlip() {
  const key = $('#grader-select').value;
  const label = GRADERS[key].name.split(' ')[0];
  const raw = num('#p-raw'), fee = num('#p-fee'), ship = num('#p-ship');
  const grades = [...$$('.grade-price')].map(inp => {
    const v = parseFloat(inp.value);
    return { g: `${label} ${inp.dataset.grade}`, sell: isFinite(v) ? v : 0 };
  }).filter(x => x.sell > 0);

  if (raw <= 0 || !grades.length) { ocrStatusCalc('Enter a raw price and at least one graded price.'); return; }
  const baseCost = raw + fee + ship; // total to buy + grade + ship
  // BGS "Base, with subgrades" adds a $3 surcharge on any card that grades a 10.
  const svcLabel = ($('#service-select').selectedOptions[0] || {}).text || '';
  const bgsSubgrade10Surcharge = (key === 'BGS' && /base, with subgrades/i.test(svcLabel)) ? 3 : 0;
  const results = grades.map(x => {
    const isTen = /\s10$/.test(x.g); // grade is exactly 10
    const cost = baseCost + (isTen ? bgsSubgrade10Surcharge : 0);
    const profit = x.sell - cost;
    const margin = cost > 0 ? (profit / cost) * 100 : 0;
    return { ...x, cost, profit, margin };
  });
  results.sort((a, b) => b.profit - a.profit);

  $('#flip-rows').innerHTML = results.map(r =>
    `<div class="flip-row">
      <div class="fr-grade">${esc(r.g)}${(/\s10$/.test(r.g) && bgsSubgrade10Surcharge) ? ' <span class="fr-note">+$3 10-subgrade</span>' : ''}</div>
      <div class="fr-nums">
        <span>Sell ${money(r.sell)}</span>
        <span class="${r.profit >= 0 ? 'pos' : 'neg'}">Profit ${money(r.profit)} (${pct(r.margin)})</span>
      </div>
    </div>`).join('');

  const best = results[0];
  $('#best-flip').innerHTML = best.profit > 0
    ? `<b>Best flip: ${esc(best.g)}</b> — buy raw at ${money(raw)}, net <b class="pos">${money(best.profit)}</b> after ${money(fee + ship)} costs.`
    : `<b class="neg">No profitable grade at these prices.</b> Raw + costs (${money(baseCost)}) exceeds every graded sale price.`;
  $('#calc-result').classList.remove('hidden');
  state._lastResults = { name: state.scan.name, code: state.scan.code, grader: label, service: ($('#service-select').selectedOptions[0]||{}).text || '', raw, fee, ship, results, when: new Date().toISOString().slice(0,10) };
  // remember these prices for this card+grader so it auto-fills next time (keyless "automation")
  const gradeMap = {};
  $$('.grade-price').forEach(inp => { const v = parseFloat(inp.value); if (isFinite(v) && v > 0) gradeMap[inp.dataset.grade] = v; });
  rememberPrices(state.scan.name, state.scan.code, label, { raw, fee, ship, grades: gradeMap });
}
function ocrStatusCalc(msg) { alert(msg); }

/* ---------- saved cards ---------- */
function saveCard() {
  if (!state._lastResults) return;
  state.saved.unshift({ id: Date.now().toString(36), ...state._lastResults });
  save(); showView('saved');
}
function renderSaved() {
  const list = $('#saved-list'); list.innerHTML = '';
  $('#saved-empty').classList.toggle('hidden', state.saved.length > 0);
  state.saved.forEach(c => {
    const best = c.results && c.results[0];
    const li = document.createElement('li'); li.className = 'saved-card';
    li.innerHTML = `
      <div class="sc-top"><span class="sc-name">${esc(c.name || 'Unnamed card')}</span><span class="sc-code">${esc(c.code || '')}</span></div>
      <div class="sc-meta">Raw ${money(c.raw)}${c.grader?` · ${esc(c.grader)}`:''} · saved ${esc(c.when)}</div>
      ${best ? `<div class="sc-best ${best.profit >= 0 ? 'pos' : 'neg'}">Best: ${esc(best.g)} → ${money(best.profit)} (${pct(best.margin)})</div>` : ''}
      <button class="btn-danger sc-del" data-del="${c.id}">Delete</button>`;
    li.querySelector('[data-del]').addEventListener('click', () => {
      if (confirm('Delete this saved card?')) { state.saved = state.saved.filter(x => x.id !== c.id); save(); renderSaved(); }
    });
    list.appendChild(li);
  });
}

/* ---------- Auto-pull prices via the Mac Helper (free, no API key) ----------
   Requires the DBZ Mac Helper (server.js) running on your MacBook + the Chrome
   extension in auto-mode, phone on the same Wi-Fi. Set the helper address in Settings. */
function helperUrl() { return (localStorage.getItem('dbz.helperUrl') || '').trim().replace(/\/$/, ''); }
function setHelperUrl(u) { localStorage.setItem('dbz.helperUrl', (u||'').trim().replace(/\/$/, '')); }

async function autoPullPrices() {
  if (!window.Cloud || !Cloud.configured()) { ocrStatusCalc('Cloud not set up. Paste your Firebase URL in cloud.js.'); return; }
  const grader = GRADERS[$('#grader-select').value].name.split(' ')[0];
  try {
    // 1) request a price update (extension fulfills it next time you open it in Chrome)
    await Cloud.enqueue(state.scan.name, state.scan.code, {});
    // 2) read whatever's already in the cloud right now (no long polling / no blocking loader)
    const key = Cloud.keyFor(state.scan.name, state.scan.code);
    let got = null; try { got = await Cloud.getPrice(key); } catch (e) {}
    const val = s => (s && s.trimmedAvg != null) ? s.trimmedAvg : null;
    if (got && got.ebay) {
      const eb = got.ebay;
      if (val(eb.raw) != null) $('#p-raw').value = val(eb.raw);
      const companyGrades = eb[grader] || {};
      $$('.grade-price').forEach(inp => { const v = val(companyGrades[inp.dataset.grade]); if (v != null) inp.value = v; });
      const gm = {}; $$('.grade-price').forEach(inp => { const v = parseFloat(inp.value); if (isFinite(v)&&v>0) gm[inp.dataset.grade]=v; });
      rememberPrices(state.scan.name, state.scan.code, grader, { raw: val(eb.raw), fee: num('#p-fee'), ship: num('#p-ship'), grades: gm });
      ['PSA','BGS','CGC'].forEach(co => {
        if (co === grader || !eb[co]) return;
        const g2 = {}; Object.keys(eb[co]).forEach(gr => { const v = val(eb[co][gr]); if (v != null) g2[gr] = v; });
        rememberPrices(state.scan.name, state.scan.code, co, { raw: val(eb.raw), fee: num('#p-fee'), ship: num('#p-ship'), grades: g2 });
      });
      const note = $('#mem-note'); if (note) { note.textContent = `↻ Loaded latest saved prices (${(got.when||'now').slice(0,10)}). Requested a fresh update too — open the extension in Chrome.`; note.classList.remove('hidden'); }
    } else {
      ocrStatusCalc('📲 Update requested. Open the DBZ extension in Chrome → Fetch, then tap this again to load the prices.');
    }
  } catch (e) {
    ocrStatusCalc('Cloud request failed. Check your internet and try again.');
  }
}

/* ---------- Top Flips (DBZ TCG watchlist) ----------
   Seed list of notable Dragon Ball Super Card Game chase cards. Prices are EDITABLE
   starting estimates (not live) — user updates them from eBay. Ranked by profit.
   NOTE: these are rough placeholders; real values move constantly — verify on eBay. */
const TOP_SEED = [
  { name: 'Vegeta, Pride of the Saiyans', code: 'BT1-085', raw: 12, top: 90 },
  { name: 'Son Goku, the Awakened Power', code: 'BT1-031', raw: 8, top: 60 },
  { name: 'Vegito SS', code: 'TB1-062', raw: 15, top: 120 },
  { name: 'Beerus, the Destroyer', code: 'BT1-086', raw: 10, top: 70 },
  { name: 'Frieza, Wrath of the White Devil', code: 'BT4-045', raw: 9, top: 65 },
  { name: 'SS4 Son Goku, Returned Warrior', code: 'BT10-152', raw: 20, top: 160 },
  { name: 'Ultra Instinct Goku', code: 'BT7-107', raw: 18, top: 140 },
  { name: 'Gogeta, Fusion Restored', code: 'BT12-155', raw: 14, top: 110 },
  { name: 'Broly, Wrath Unleashed', code: 'BT5-092', raw: 11, top: 80 },
  { name: 'Cell, Perfect Form', code: 'BT2-064', raw: 7, top: 55 },
  { name: 'Trunks, Hope of the Future', code: 'BT3-088', raw: 6, top: 45 },
  { name: 'Android 21, Hunger Overwhelming', code: 'BT6-113', raw: 13, top: 95 }
];
function loadWatchlist() {
  const saved = JSON.parse(localStorage.getItem('dbz.watch') || 'null');
  return saved && saved.length ? saved : TOP_SEED.map(c => ({ ...c }));
}
function saveWatchlist(w) { localStorage.setItem('dbz.watch', JSON.stringify(w)); }

/* ---------- Learning layer ----------
   The app "learns" from user corrections without any API. Corrections are logged
   locally and exportable as developer JSON, so the user can share them and the seed
   list / (later) the eBay search queries can be improved. API-ready: when the eBay
   key + backend exist, these same corrections tune the live auto-pull query per card. */
function loadCorrections() { return JSON.parse(localStorage.getItem('dbz.corrections') || '[]'); }
function saveCorrections(c) { localStorage.setItem('dbz.corrections', JSON.stringify(c)); }
function loadHidden() { return JSON.parse(localStorage.getItem('dbz.hidden') || '[]'); }
function saveHidden(h) { localStorage.setItem('dbz.hidden', JSON.stringify(h)); }

/* Reason categories for a bad pull/listing — helps you (and dev) know WHY it was wrong. */
const FLAG_REASONS = [
  'Wrong card (different card entirely)',
  'Wrong TCG (not Dragon Ball / wrong game)',
  'Wrong variant/parallel (foil, promo, reprint)',
  'False data (price looks fake / manipulated)',
  'Wrong listing (bundle, lot, damaged, proxy)',
  'Price way off (stale or unrealistic)',
  'Sold vs active mismatch',
  'Other'
];
function flagCard(code) {
  const w = loadWatchlist(); const c = w.find(x => x.code === code); if (!c) return;
  const menu = FLAG_REASONS.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const pick = prompt(
    `Why is "${c.name}" (${c.code}) a bad pull?\n\n${menu}\n\nEnter a number (1-${FLAG_REASONS.length}):`, '');
  if (pick === null) return;
  const idx = parseInt(pick, 10) - 1;
  const category = (idx >= 0 && idx < FLAG_REASONS.length) ? FLAG_REASONS[idx] : 'Other';
  const note = prompt('Optional detail (correct name/code, what you saw, etc.) — or leave blank:', '') || '';
  const corr = loadCorrections();
  corr.push({ code: c.code, name: c.name, category, note: note.trim(), when: new Date().toISOString() });
  saveCorrections(corr);
  // hide it from the ranked view (soft-hide, not destroyed — recorded in corrections)
  const hidden = loadHidden(); if (!hidden.includes(c.code)) { hidden.push(c.code); saveHidden(hidden); }
  rankTop();
  alert(`Logged: "${category}". Hidden from Top 10 and saved to corrections — export & share it so the app can be improved.`);
}

/* Show the corrections log (editable side-notes) before exporting. */
function toggleCorrections() {
  const wrap = $('#corrections-review'); if (!wrap) return;
  if (!wrap.classList.contains('hidden')) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  drawCorrections();
}
function drawCorrections() {
  const wrap = $('#corrections-review'); if (!wrap) return;
  const corr = loadCorrections();
  if (!corr.length) {
    wrap.innerHTML = `<div class="cr-title">Corrections log</div><p class="hint">Nothing flagged yet. Use "⚑ Wrong" on a card to log a correction.</p>`;
    return;
  }
  wrap.innerHTML = `<div class="cr-title">Corrections log (${corr.length}) — editable</div>` + corr.map((c, i) => `
    <div class="cr-item">
      <div class="cr-head"><b>${esc(c.name || '?')}</b> <span class="ti-code">${esc(c.code || '')}</span>
        <button class="cr-del" data-del-corr="${i}" aria-label="Remove">✕</button></div>
      <div class="cr-cat">${esc(c.category || c.issue || 'Flagged')}</div>
      <label class="cr-note-lbl">Your note (side comments for the developer):
        <textarea class="cr-note" data-note-idx="${i}" rows="2" placeholder="Add any detail — correct name/code, what you saw, etc.">${esc(c.note || '')}</textarea>
      </label>
      <div class="cr-when">${esc((c.when || '').slice(0,10))}</div>
    </div>`).join('');
  wrap.querySelectorAll('.cr-note').forEach(t => t.addEventListener('input', e => {
    const arr = loadCorrections(); const idx = +e.target.dataset.noteIdx;
    if (arr[idx]) { arr[idx].note = e.target.value; saveCorrections(arr); }
  }));
  wrap.querySelectorAll('[data-del-corr]').forEach(btn => btn.addEventListener('click', () => {
    const arr = loadCorrections(); arr.splice(+btn.dataset.delCorr, 1); saveCorrections(arr); drawCorrections();
  }));
}

function exportCorrections() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'dbz-money-maker',
    note: 'User learning data — share with developer to improve seed list & search queries.',
    watchlist: loadWatchlist(),
    corrections: loadCorrections(),
    hidden: loadHidden(),
    priceMemory: loadMemory(),
    savedCards: state.saved
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `dbz-learning-${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
}
function importLearning(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if (d.watchlist) saveWatchlist(d.watchlist);
      if (d.corrections) saveCorrections(d.corrections);
      if (d.hidden) saveHidden(d.hidden);
      if (d.priceMemory) saveMemory(d.priceMemory);
      if (d.savedCards) { state.saved = d.savedCards; save(); }
      rankTop();
      alert('Imported learning data. Watchlist and corrections updated.');
    } catch (err) { alert('Could not read that file — make sure it\u2019s a dbz-learning JSON export.'); }
  };
  reader.readAsText(file);
}

// Friendly "last updated" for Top 10 prices. Honest: seed prices were never verified.
function fmtUpdated(iso){
  if (!iso) return 'never (starting estimate — verify on eBay)';
  const then = new Date(iso).getTime(); if (!isFinite(then)) return 'unknown';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins/60); if (hrs < 24) return `${hrs} hr${hrs===1?'':'s'} ago`;
  const days = Math.floor(hrs/24); if (days < 30) return `${days} day${days===1?'':'s'} ago`;
  return new Date(iso).toISOString().slice(0,10);
}

function rankTop() {
  const min = num('#filt-min') || 0;
  const max = num('#filt-max') || Infinity;
  const hidden = loadHidden();
  // use BGS Standard as the default flip assumption for ranking, + $15 ship
  const fee = 34.95, ship = 15;
  const watch = loadWatchlist();
  const ranked = watch
    .filter(c => !hidden.includes(c.code))
    .filter(c => c.raw >= min && c.raw <= max)
    .map(c => {
      const cost = c.raw + fee + ship;
      const profit = (c.top || 0) - cost;
      const margin = cost > 0 ? (profit / cost) * 100 : 0;
      return { ...c, cost, profit, margin };
    })
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10);

  const q = c => encodeURIComponent(`${c.name} ${c.code}`.trim());
  $('#top-list').innerHTML = ranked.length ? ranked.map((c, i) => `
    <li class="top-item">
      <div class="ti-rank">${i + 1}</div>
      <div class="ti-body">
        <div class="ti-name">${esc(c.name)} <span class="ti-code">${esc(c.code)}</span></div>
        <div class="ti-nums">
          <span>Raw ~${money(c.raw)}</span><span>Grade10 ~${money(c.top)}</span>
          <span class="${c.profit >= 0 ? 'pos' : 'neg'}">Profit ${money(c.profit)} (${pct(c.margin)})</span>
        </div>
        <div class="ti-updated">Prices updated: ${fmtUpdated(c.lastUpdated)}</div>
        <div class="ti-why">
          <div class="ti-why-lbl">WHY THIS FLIP</div>
          <div class="ti-calc">Grade10 ${money(c.top)} − Raw ${money(c.raw)} − Grade $34.95 − Ship $15 = <b class="${c.profit >= 0 ? 'pos' : 'neg'}">${money(c.profit)}</b></div>
          <ul class="ti-reasons">${flipReasoning(c).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>
        <div class="ti-actions">
          <a class="mini-link" href="https://www.ebay.com/sch/i.html?_nkw=${q(c)}&LH_BIN=1&_sop=15" target="_blank" rel="noopener">Raw ↗</a>
          <a class="mini-link" href="https://www.ebay.com/sch/i.html?_nkw=${q(c)}%20BGS%2010&LH_BIN=1&_sop=15" target="_blank" rel="noopener">BGS 10 ↗</a>
          <button class="mini-btn" data-edit-watch="${esc(c.code)}">Edit prices</button>
          <button class="mini-btn flag" data-flag-watch="${esc(c.code)}">⚑ Wrong</button>
        </div>
      </div>
    </li>`).join('') : `<li class="top-empty">No cards in that raw price range.</li>`;

  // wire edit + flag buttons
  $$('[data-edit-watch]').forEach(btn => btn.addEventListener('click', () => editWatch(btn.dataset.editWatch)));
  $$('[data-flag-watch]').forEach(btn => btn.addEventListener('click', () => flagCard(btn.dataset.flagWatch)));
}

/* Plain-English reasoning for why a card ranks as a flip — built from the numbers. */
function flipReasoning(c) {
  const reasons = [];
  const mult = c.raw > 0 ? c.top / c.raw : 0;
  // profit multiple
  if (mult >= 6) reasons.push(`Graded 10 sells for ~${mult.toFixed(1)}× the raw price — very high upside multiple.`);
  else if (mult >= 3) reasons.push(`Graded 10 is ~${mult.toFixed(1)}× the raw cost — solid grading premium.`);
  else if (mult > 0) reasons.push(`Only ~${mult.toFixed(1)}× raw — thin grading premium, low margin of safety.`);
  // covers grading cost?
  const gradeCost = 34.95 + 15;
  if (c.profit > gradeCost) reasons.push(`Profit clears the ~${money(gradeCost)} grade+ship cost with room to spare.`);
  else if (c.profit > 0) reasons.push(`Profit is positive but thin — one bad grade (9 instead of 10) could wipe it out.`);
  else reasons.push(`Currently underwater after grade+ship costs — not worth flipping at these prices.`);
  // raw entry cost
  if (c.raw <= 10) reasons.push(`Low raw cost (${money(c.raw)}) = small downside if it grades poorly.`);
  else if (c.raw >= 25) reasons.push(`Higher raw cost (${money(c.raw)}) = more capital at risk if it doesn't grade a 10.`);
  // grading-risk caveat (always honest)
  reasons.push(`Assumes a PSA/BGS 10 outcome — real grades vary; a 9 or below sells for much less.`);
  return reasons;
}
function editWatch(code) {
  const w = loadWatchlist();
  const c = w.find(x => x.code === code); if (!c) return;
  const raw = prompt(`Raw price for ${c.name} (${c.code}):`, c.raw);
  if (raw === null) return;
  const top = prompt(`Top graded (10) sale price for ${c.name}:`, c.top);
  if (top === null) return;
  c.raw = parseFloat(raw) || c.raw;
  c.top = parseFloat(top) || c.top;
  c.lastUpdated = new Date().toISOString();
  saveWatchlist(w);
  rankTop();
}

/* ========================================================================
   COLLECTION / PORTFOLIO UI
   ======================================================================== */
let colRange = 'all';
let currentCardKey = null;  // card currently shown in detail

const PERF_WINDOWS = [
  {k:'today',label:'Today'}, {k:'7d',label:'7 Days'}, {k:'30d',label:'30 Days'},
  {k:'3mo',label:'3 Months'}, {k:'6mo',label:'6 Months'}, {k:'ytd',label:'YTD'},
  {k:'1yr',label:'1 Year'}, {k:'all',label:'All Time'}
];

/* ---------- Business Inventory (Phase 1) ---------- */
let invStatusFilter = 'all';
let invSearch = '';
let invExpanded = null; // item id whose min-sell table is open

function invItemCard(it){ return Collection.getCard(it.cardKey) || {}; }
// Thumbnail HTML for a card: prefer a saved image; else show the OFFICIAL image live
// from the DB URL (works even if we can't cache it); else the placeholder.
// ---- Image loading progress bar (top) ----
const _imgProg = { total: 0, done: 0 };
let _imgProgSafety = null;
function imgProgStart(){
  _imgProg.total++;
  const bar = $('#img-progress'); if (bar) bar.classList.remove('hidden');
  imgProgPaint();
  // Overall safety net: if the whole batch isn't done within 8s, force-complete
  // (some image hosts hang without firing load/error — don't let the bar stick).
  if (_imgProgSafety) clearTimeout(_imgProgSafety);
  _imgProgSafety = setTimeout(()=>{ _imgProg.done = _imgProg.total; imgProgPaint();
    const b=$('#img-progress'); if(b) b.classList.add('hidden'); _imgProg.total=0; _imgProg.done=0; }, 8000);
}
function imgProgDone(){
  _imgProg.done++;
  imgProgPaint();
  if (_imgProg.done >= _imgProg.total) {
    if (_imgProgSafety) { clearTimeout(_imgProgSafety); _imgProgSafety = null; }
    setTimeout(()=>{ const bar=$('#img-progress'); if (bar && _imgProg.done>=_imgProg.total){ bar.classList.add('hidden'); _imgProg.total=0; _imgProg.done=0; } }, 400);
  }
}
function imgProgPaint(){
  const f = $('#img-progress-fill'); if (!f) return;
  const pct = _imgProg.total ? Math.round(_imgProg.done/_imgProg.total*100) : 0;
  f.style.width = pct + '%';
}

function cardThumbHtml(card){
  let src = '';
  // Prefer the OFFICIAL card image (from the DB, by number) over the user's scan photo.
  if (card && card.number && window.CardDB && CardDB.imageUrl) {
    try { src = CardDB.imageUrl(card.number) || ''; } catch (e) {}
  }
  // Fall back to a saved photo (for cards with no number / not in DB).
  if (!src && card && card.image) src = card.image;
  if (src) {
    if (src.startsWith('http')) { try { imgProgStart(); } catch(e){} }
    const track = src.startsWith('http') ? ' onload="imgProgDone()" ' : '';
    // If the official URL fails, fall back to the saved photo (if any), else placeholder.
    const fb = (card && card.image && card.image !== src) ? card.image : '';
    const onerr = fb
      ? `imgProgDone&&imgProgDone();this.onerror=null;this.src='${fb}';this.removeAttribute('data-zoom');this.setAttribute('data-zoom','${fb}')`
      : `imgProgDone&&imgProgDone();this.replaceWith(document.createTextNode('🃏'))`;
    return `<img src="${src}"${track}alt="" loading="lazy" data-zoom="${src}" onerror="${onerr}">`;
  }
  return '🃏';
}
function invItemName(it){ const c = invItemCard(it); return c.name ? `${c.name}${c.number?' · '+c.number:''}` : (it.cardKey||'Card'); }
function invGradeLabel(it){
  if (it.condition === 'graded') return `${it.company||'?'} ${it.grade||''}`.trim();
  return 'Raw';
}

function renderInventory(){
  renderBizDashboard();
  renderBackupStatus();
  // populate status filter once
  const sel = $('#inv-status-filter');
  if (sel && sel.options.length <= 1) {
    Inventory.STATUSES.forEach(s => { const o=document.createElement('option'); o.value=s.key; o.textContent=s.label; sel.appendChild(o); });
    sel.value = invStatusFilter;
  }

  const all = (Collection.items ? Collection.items() : []);
  const filtered = all.filter(it => {
    const st = it.status || 'in_inventory';
    // Default 'all' = everything you still HOLD (exclude sold). Pick the 'sold' filter to see sold.
    if (invStatusFilter === 'all') { if (st === 'sold') return false; }
    else if (st !== invStatusFilter) return false;
    if (invSearch) { const nm = invItemName(it).toLowerCase(); if (!nm.includes(invSearch.toLowerCase())) return false; }
    return true;
  });

  // summary
  let totBasis = 0, totEst = 0, realized = 0, count = 0;
  all.forEach(it => {
    totBasis += Inventory.costBasisTotal(it);
    const est = Inventory.estValue(it); if (est!=null) totEst += est * (it.qty||1);
    if (it.status==='sold' && it.sale) { const p = Inventory.profitability(it); if (p.profit!=null) realized += p.profit * (it.qty||1); }
    count += (it.qty||1);
  });
  const sumEl = $('#inv-summary');
  if (sumEl) sumEl.innerHTML =
    `<div class="inv-sum-row"><span>Items</span><b>${count}</b></div>`+
    `<div class="inv-sum-row"><span>Total cost basis</span><b>${money(Inventory.round2(totBasis))}</b></div>`+
    `<div class="inv-sum-row"><span>Est. current value</span><b>${money(Inventory.round2(totEst))}</b></div>`+
    `<div class="inv-sum-row"><span>Realized profit</span><b class="${realized>=0?'pos':'neg'}">${money(Inventory.round2(realized))}</b></div>`;

  // export-to-ProfitTrack summary
  const exEl = $('#export-summary');
  if (exEl && window.BridgeExport) {
    const txns = BridgeExport.buildTransactions();
    const snap = BridgeExport.inventorySnapshot();
    const sales = txns.filter(t=>t.type==='income').length;
    const exp = txns.filter(t=>t.type==='expense').length;
    exEl.innerHTML =
      `<div class="inv-sum-row"><span>Transactions to export</span><b>${txns.length}</b></div>`+
      `<div class="inv-sum-row"><span>Sales / Expenses</span><b>${sales} / ${exp}</b></div>`+
      `<div class="inv-sum-row"><span>Inventory cost basis</span><b>${money(snap.costBasis)}</b></div>`;
  }

  // list
  const listEl = $('#inv-list');
  if (!listEl) return;
  if (!filtered.length) { listEl.innerHTML = `<p class="hint">No items${invStatusFilter!=='all'?' with this status':''} yet. Add cards to your Collection and they'll appear here with full cost-basis tracking.</p>`; return; }

  listEl.innerHTML = groupInventory(filtered)
    .sort((ga, gb) => invItemName(ga.items[0]).toLowerCase().localeCompare(invItemName(gb.items[0]).toLowerCase()))
    .map(group => {
    if (group.items.length === 1) return renderInvItemRow(group.items[0]);
    return renderInvStack(group);
  }).join('');

  // Lazily fetch+cache ONE missing official image per render (avoids a network burst).
  try {
    if (window.CardDB && CardDB.count && CardDB.count() > 0) {
      const seen = {};
      for (const it of filtered) {
        const card = Collection.getCard(it.cardKey);
        if (card && card.number && !card.officialImage && !seen[card.key]) {
          seen[card.key] = 1; cacheCardImage(card.key, card.number); break;
        }
      }
    }
  } catch(e){}

  // Per-image watchdog: any official image still not loaded after 7s is treated as
  // failed → swap to placeholder + count it done (so the progress bar can't hang).
  setTimeout(()=>{
    try {
      document.querySelectorAll('.inv-thumb img[data-zoom^="http"]').forEach(img=>{
        if (!img.complete || img.naturalWidth === 0) {
          try { if (typeof imgProgDone==='function') imgProgDone(); } catch(e){}
          img.replaceWith(document.createTextNode('🃏'));
        }
      });
    } catch(e){}
  }, 7000);
}

// Group items into stacks: same card + condition + grade-company + grade + status.
// Cost is NOT blended — each item keeps its own basis; the stack just sums for display.
function invStackKey(it){
  return [it.cardKey, it.condition||'raw', it.company||'', it.grade||'', it.status||'in_inventory'].join('||');
}
function groupInventory(items){
  const map = new Map();
  items.forEach(it => { const k = invStackKey(it); if(!map.has(k)) map.set(k, { key:k, items:[] }); map.get(k).items.push(it); });
  return [...map.values()];
}

// A collapsed stack of 2+ identical cards: one summary row that expands to the individual copies.
function renderInvStack(group){
  const items = group.items;
  const first = items[0];
  const st = first.status || 'in_inventory';
  const totalQty = items.reduce((s,it)=>s+(it.qty||1),0);
  const totalBasis = items.reduce((s,it)=>s+Inventory.costBasisTotal(it),0);
  const avgBasis = totalQty ? totalBasis/totalQty : 0;
  const expanded = invExpanded === group.key;
  // summed realized profit if all sold, else potential
  let profitLine;
  const allSold = items.every(it=>it.status==='sold' && it.sale);
  if (allSold) {
    const profit = items.reduce((s,it)=>{ const p=Inventory.profitability(it); return s+(p.profit||0)*(it.qty||1); },0);
    profitLine = `<span class="${profit>=0?'pos':'neg'}">Sold ${items.length} · total profit ${money(Inventory.round2(profit))}</span>`;
  } else {
    profitLine = `<span class="muted">${items.length} copies · tap to expand</span>`;
  }
  const c = invItemCard(first);
  const sub = items.map(it => renderInvItemRow(it, true)).join('');
  return `<div class="inv-item inv-stack" data-inv-stack="${group.key}">
      <div class="inv-item-head" data-action="inv-expand" data-id="${group.key}">
        <div class="inv-thumb">${cardThumbHtml(c)}</div>
        <div class="inv-item-main">
          <div class="inv-item-name">${escapeHtmlSafe(invItemName(first))} <span class="inv-stack-badge">×${totalQty}</span></div>
          <div class="inv-item-sub">${invGradeLabel(first)} · ${items.length} entries · <span class="inv-badge inv-${st}">${Inventory.statusLabel(st)}</span></div>
        </div>
        <div class="inv-item-nums">
          <div class="inv-basis">Total ${money(Inventory.round2(totalBasis))}</div>
          <div class="inv-be">Avg ${money(Inventory.round2(avgBasis))}/ea</div>
        </div>
      </div>
      <div class="inv-item-profit">${profitLine}</div>
      ${expanded ? `<div class="inv-stack-items">${sub}</div>` : ''}
    </div>`;
}

// Render ONE inventory item row (used for singles and for each copy inside an expanded stack).
function renderInvItemRow(it, forceExpanded){
    const basis = Inventory.costBasis(it);
    const p = Inventory.profitability(it);
    const st = it.status || 'in_inventory';
    const be = Inventory.breakEven(it);
    const expanded = forceExpanded || invExpanded === it.id;
    let profitLine;
    if (p.realized) {
      profitLine = `<span class="${p.profit>=0?'pos':'neg'}">Sold ${money(p.salePrice)} · net ${money(p.net)} · profit ${money(p.profit)}${p.roi!=null?` (${p.roi}%)`:''}</span>`;
    } else if (p.potentialProfit!=null) {
      profitLine = `<span class="${p.potentialProfit>=0?'pos':'neg'}">Potential ${money(p.potentialProfit)}${p.potentialRoi!=null?` (${p.potentialRoi}%)`:''}</span>`;
    } else {
      profitLine = `<span class="muted">Sell above ${money(be)} to profit</span>`;
    }
    const table = expanded ? `<div class="inv-minsell">`+
      Inventory.minSellTable(it).map(r=>`<div class="inv-ms-row"><span>${r.label}</span><b>${money(r.price)}</b></div>`).join('')+
      `<div class="inv-ms-note">Break-even & margins include selling fees (${Inventory.settings().feePct}% + $${Inventory.settings().feeFlat}).</div></div>` : '';
    return `<div class="inv-item" data-inv-id="${it.id}">
      <div class="inv-item-head"${forceExpanded ? '' : ` data-action="inv-expand" data-id="${it.id}"`}>
        <div class="inv-thumb">${cardThumbHtml(invItemCard(it))}</div>
        <div class="inv-item-main">
          <div class="inv-item-name">${escapeHtmlSafe(invItemName(it))}</div>
          <div class="inv-item-sub">${invGradeLabel(it)} · qty ${it.qty||1} · <span class="inv-badge inv-${st}">${Inventory.statusLabel(st)}</span></div>
        </div>
        <div class="inv-item-nums">
          <div class="inv-basis">Basis ${money(basis)}</div>
          <div class="inv-be">Break-even ${money(be)}</div>
          ${(!forceExpanded && st!=='sold' && st!=='at_grading')
            ? `<button class="inv-quick-sell" data-action="inv-sell" data-id="${it.id}" title="Sell">💵 Sell</button>` : ''}
        </div>
      </div>
      <div class="inv-item-profit">${profitLine}</div>
      ${table}
      ${expanded ? (
        (st!=='sold' && st!=='at_grading'
          ? `<button class="btn-primary block inv-edit-btn" data-action="inv-sell" data-id="${it.id}">💵 Sell this card</button>`
          : '')+
        `<button class="btn-secondary block inv-edit-btn" data-action="inv-edit" data-id="${it.id}">✎ Edit costs / status / sale</button>`+
        (st==='at_grading'
          ? `<button class="btn-primary block inv-edit-btn" data-action="grade-complete" data-id="${it.id}">🏆 Grading returned — enter grade</button>`
          : (st!=='sold'
            ? `<button class="btn-secondary block inv-edit-btn" data-action="grade-send" data-id="${it.id}">📮 Send to Grading</button>`
            : ''))) : ''}
    </div>`;
}

function escapeHtmlSafe(s){ return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* inventory item editor */
let invEditingId = null;
let _edPhoto = '';
function invFindItem(id){ return (Collection.items()||[]).find(x=>x.id===id) || null; }
function openInvEditor(id){
  const it = invFindItem(id); if (!it) return;
  invEditingId = id;
  // populate status dropdown once
  const sel = $('#ed-status');
  if (sel && !sel.options.length) Inventory.STATUSES.forEach(s=>{ const o=document.createElement('option'); o.value=s.key; o.textContent=s.label; sel.appendChild(o); });
  const a = it.acq||{}, g = it.grading||{}, sale = it.sale||{};
  $('#inv-ed-title').textContent = invItemName(it);
  const card = Collection.getCard(it.cardKey) || {};
  if ($('#ed-card-name')) $('#ed-card-name').value = card.name || '';
  if ($('#ed-card-number')) $('#ed-card-number').value = card.number || '';
  _edPhoto = card.image || '';
  if ($('#ed-photo-preview')) $('#ed-photo-preview').innerHTML = _edPhoto ? `<img src="${_edPhoto}" style="width:100%;height:100%;object-fit:cover">` : '🃏';
  $('#ed-acq-price').value = a.price ?? (it.purchaseCost ?? '');   // migrate old purchaseCost (stored PER-UNIT)
  if ($('#ed-price-mode')) $('#ed-price-mode').value = 'each';      // stored value is per-unit
  if ($('#ed-qty-label')) $('#ed-qty-label').textContent = (it.qty>1) ? `· qty ${it.qty}` : '';
  $('#ed-acq-ship').value = a.shipping ?? '';
  $('#ed-acq-tax').value = a.tax ?? '';
  $('#ed-acq-other').value = a.other ?? '';
  $('#ed-acq-date').value = a.date ?? (it.dateAdded||'');
  $('#ed-grd-fee').value = g.fee ?? '';
  $('#ed-grd-shipto').value = g.shipTo ?? '';
  $('#ed-grd-shipback').value = g.shipBack ?? '';
  $('#ed-grd-other').value = g.other ?? '';
  $('#ed-status').value = it.status || 'in_inventory';
  $('#ed-list-price').value = it.listPrice ?? '';
  $('#ed-sale-price').value = sale.price ?? '';
  $('#ed-sale-fees').value = sale.fees ?? '';
  $('#ed-sale-date').value = sale.date ?? '';
  updateInvBasisPreview();
  $('#inv-editor').classList.remove('hidden');
}
function closeInvEditor(){ $('#inv-editor').classList.add('hidden'); invEditingId = null; }

// Quick sell directly from the Business dashboard (no need to open the full editor).
function sellInvItem(id){
  const it = invFindItem(id); if (!it) return;
  const name = invItemName(it);
  const basis = Inventory.costBasis(it);
  const raw = prompt(`Sell "${name}"\n\nCost basis: ${money(basis)}\nEnter the SALE price (what the buyer paid):`, '');
  if (raw === null) return;
  const price = parseFloat(String(raw).replace(/[^0-9.]/g,''));
  if (!isFinite(price) || price < 0) { alert('Enter a valid sale price.'); return; }
  const fees = Inventory.feeOn(price);
  const patch = { status:'sold', sale:{ price, fees, date: Collection.today() } };
  // lock in allocated pack cost for pulls (so profit uses cost at sale time)
  if (window.Products && Products.allocatedCostForItem) {
    const live = Products.allocatedCostForItem(id);
    if (live > 0) patch.allocLocked = live;
  }
  Collection.updateItem(id, patch);
  const net = Inventory.round2(price - fees);
  const profit = Inventory.round2(net - basis);
  renderInventory();
  alert(`✓ Sold ${name} for ${money(price)}\nFees: ${money(fees)} · Net: ${money(net)}\nProfit: ${money(profit)}`);
}
function edNum(id){ const v = parseFloat($(id).value); return isFinite(v) ? v : 0; }
// Convert the editor's acquisition inputs to PER-UNIT (stored per-unit). Total mode ÷ qty.
function edPerUnitAcq(){
  const it = invFindItem(invEditingId);
  const qty = Math.max(1, (it && it.qty) || 1);
  const mode = ($('#ed-price-mode') && $('#ed-price-mode').value) || 'each';
  const div = mode === 'total' ? qty : 1;
  return { qty, price:edNum('#ed-acq-price')/div, shipping:edNum('#ed-acq-ship')/div, tax:edNum('#ed-acq-tax')/div, other:edNum('#ed-acq-other')/div };
}
function updateInvBasisPreview(){
  const u = edPerUnitAcq();
  const probe = { qty:u.qty,
    acq:{ price:u.price, shipping:u.shipping, tax:u.tax, other:u.other },
    grading:{ fee:edNum('#ed-grd-fee'), shipTo:edNum('#ed-grd-shipto'), shipBack:edNum('#ed-grd-shipback'), other:edNum('#ed-grd-other') } };
  const perUnit = Inventory.costBasis(probe);
  const total = Inventory.costBasisTotal(probe);
  const be = Inventory.breakEven(probe);
  const el = $('#inv-ed-basis');
  if (el) el.innerHTML =
    `<div class="inv-sum-row"><span>Total cost (${u.qty} card${u.qty===1?'':'s'})</span><b>${money(total)}</b></div>`+
    `<div class="inv-sum-row"><span>Per card</span><b>${money(perUnit)}</b></div>`+
    `<div class="inv-sum-row"><span>Break-even each (after fees)</span><b>${money(be)}</b></div>`;
}
function saveInvEditor(){
  const it = invFindItem(invEditingId); if (!it) { closeInvEditor(); return; }
  // apply card name/number edits first (may re-point cardKey)
  const card = Collection.getCard(it.cardKey) || {};
  const newName = ($('#ed-card-name') ? $('#ed-card-name').value.trim() : card.name) || card.name;
  const newNum  = ($('#ed-card-number') ? $('#ed-card-number').value.trim() : card.number);
  if (card && (newName !== card.name || newNum !== card.number)) {
    Collection.renameCard(it.cardKey, { name:newName, number:newNum });
    // refetch the item since its cardKey may have changed
    const moved = (Collection.items()||[]).find(x => x.id === invEditingId);
    if (moved) invEditingId = moved.id; // id is stable; cardKey updated internally
  }
  // save photo (if changed) onto the (possibly renamed) card
  { const cur = invFindItem(invEditingId); if (cur) { const c = Collection.getCard(cur.cardKey)||{}; Collection.upsertCard({ name:c.name, number:c.number, set:c.set, variant:c.variant, language:c.language, image:_edPhoto||c.image||'' }); } }
  const patch = {
    acq: (()=>{ const u=edPerUnitAcq(); return { price:Inventory.round2(u.price), shipping:Inventory.round2(u.shipping), tax:Inventory.round2(u.tax), other:Inventory.round2(u.other), date:$('#ed-acq-date').value||null }; })(),
    grading: { fee:edNum('#ed-grd-fee'), shipTo:edNum('#ed-grd-shipto'), shipBack:edNum('#ed-grd-shipback'), other:edNum('#ed-grd-other') },
    status: $('#ed-status').value,
    listPrice: $('#ed-list-price').value!=='' ? edNum('#ed-list-price') : null
  };
  const sp = $('#ed-sale-price').value;
  if (sp !== '') {
    patch.sale = { price: edNum('#ed-sale-price'),
                   fees: $('#ed-sale-fees').value!=='' ? edNum('#ed-sale-fees') : Inventory.feeOn(edNum('#ed-sale-price')),
                   date: $('#ed-sale-date').value || Collection.today() };
    if (patch.status !== 'sold') patch.status = 'sold'; // recording a sale => sold
  }
  // If this card is a pull being SOLD, lock in its current allocated box cost now,
  // so its profit uses the box cost it was carrying at sale time (not 0 afterward).
  if (patch.status === 'sold' && window.Products && Products.allocatedCostForItem) {
    const live = Products.allocatedCostForItem(invEditingId);
    if (live > 0) patch.allocLocked = live;
  }
  Collection.updateItem(invEditingId, patch);
  closeInvEditor();
  renderInventory();
}

async function copyBridgeData(){
  const st = $('#bridge-status'), ta = $('#bridge-json');
  if (!window.BridgeExport) { if(st){st.textContent='Export module not loaded.'; st.style.color='#ff8b7f';} return; }
  const json = BridgeExport.toJSON();
  if (ta) ta.value = json;
  try {
    await navigator.clipboard.writeText(json);
    if (st) { st.textContent = '✓ Copied. Open Profit Track → Import DBZ Data → paste.'; st.style.color = '#38d17a'; }
  } catch (e) {
    // clipboard blocked — select the textarea so the user can copy manually
    if (ta) { ta.focus(); ta.select(); }
    if (st) { st.textContent = 'Couldn\u2019t auto-copy — the data is selected below, copy it manually.'; st.style.color = '#ffcf5c'; }
  }
}

/* ---------- Push ProfitTrack ledger to cloud (same payload as copy-paste export) ---------- */
let _lastLedgerPush = 0;
async function pushLedgerToCloud(){
  if (!window.Cloud || !Cloud.configured() || !window.BridgeExport) return;
  if (Date.now() - _lastLedgerPush < 30000) return;   // throttle to once/30s
  _lastLedgerPush = Date.now();
  try { await Cloud.putLedger(BridgeExport.buildPayload()); } catch (e) {}
}

/* ---------- Publish held cards for daily auto-refresh ---------- */
let _lastHeldPublish = 0;
async function publishHeldCards(){
  if (!window.Cloud || !Cloud.configured()) return;
  // throttle: at most once per 60s
  if (Date.now() - _lastHeldPublish < 60000) return;
  _lastHeldPublish = Date.now();
  try {
    const held = (Collection.items()||[]).filter(it => it.status !== 'sold');
    const seen = {};
    const cards = [];
    held.forEach(it => {
      const c = Collection.getCard(it.cardKey); if (!c) return;
      const k = Cloud.keyFor(c.name, c.number);
      if (seen[k]) return; seen[k] = 1;
      cards.push({ name:c.name, code:c.number||'', set:c.set||'', variant:c.variant||'' });
    });
    await Cloud.putHeldCards(cards);
  } catch (e) {}
}

/* ---------- Backup & Restore (data safety) ---------- */
function renderBackupStatus(){
  const el = $('#backup-status'); if (!el || !window.Backup) return;
  const when = Backup.lastBackupWhen();
  let ago = 'never', stale = true;
  if (when) {
    const days = Math.floor((Date.now() - new Date(when).getTime()) / 86400000);
    ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
    stale = days > 5;
  }
  el.innerHTML = `<div class="inv-sum-row"><span>Last backup</span><b class="${stale?'neg':'pos'}">${ago}</b></div>`+
                 `<div class="inv-sum-row"><span>Auto-backup</span><b>every 3 days</b></div>`+
                 `<div class="inv-sum-row"><span>App version</span><b>${window.APP_VERSION||'?'}</b></div>`+
                 (stale ? `<div class="hint" style="color:#d29922;margin-top:4px">⚠️ Consider backing up — download a copy to keep it safe.</div>` : '');
}
function backupNowUI(){
  if (!window.Backup) return;
  const ok = Backup.backupNow();
  const s = $('#backup-restore-status');
  if (s) { s.textContent = ok ? '✓ Backed up.' : 'Backup failed (storage full?).'; s.style.color = ok ? '#38d17a' : '#ff8b7f'; }
  renderBackupStatus();
}
function restoreBackupFile(file){
  const r = new FileReader();
  r.onload = e => {
    const res = Backup.restoreFromText(e.target.result);
    const s = $('#backup-restore-status');
    if (res.ok) { s.textContent = `✓ Restored from ${(res.when||'').slice(0,10)}. Reloading…`; s.style.color='#38d17a'; setTimeout(()=>location.reload(), 900); }
    else { s.textContent = res.error || 'Restore failed.'; s.style.color='#ff8b7f'; }
  };
  r.readAsText(file);
}

/* ---------- Add card directly to inventory (Business tab) ---------- */
let _afPhoto = '';   // photo chosen on the add-card form (thumbnail data URL)
// Scan a card image and fill the add-card form's name/number (reuses OCR pipeline).
async function scanIntoAddCard(file){
  const st = $('#af-scan-status');
  if (typeof Tesseract === 'undefined') { if(st) st.textContent = 'OCR still loading — try again in a second.'; return; }
  if (st) st.textContent = 'Reading card…';
  showLoader('Reading card…');
  try {
    const img = new Image();
    const _u = URL.createObjectURL(file);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = _u; });
    // Cap source size to avoid iOS out-of-memory tab kills on large library photos.
    const MAX_EDGE = 1600;
    const _sc = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * _sc); c.height = Math.round(img.naturalHeight * _sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(_u);
    let name, code;
    if (typeof Scanner !== 'undefined') {
      const r = await Scanner.scan(c);
      name = r.name; code = r.cardNumber;
    } else {
      const nameRegion = cropCanvas(c, 0, 0, c.width, Math.round(c.height * 0.18));
      const codeRegion = cropCanvas(c, Math.round(c.width * 0.55), Math.round(c.height * 0.82), Math.round(c.width * 0.45), Math.round(c.height * 0.18));
      const [nameRes, codeRes] = await Promise.all([ Tesseract.recognize(nameRegion,'eng'), Tesseract.recognize(codeRegion,'eng') ]);
      name = cleanName(nameRes.data.text); code = cleanCode(codeRes.data.text);
    }
    if ($('#af-name')) $('#af-name').value = name || '';
    if ($('#af-number')) $('#af-number').value = code || '';
    if (st) st.textContent = '✓ Read — check & fix any misreads, then fill costs.';
  } catch (e) {
    if (st) st.textContent = 'Could not read the card — type it in manually.';
  } finally { hideLoader(); }
}

function toggleAddCardForm(){
  const f = $('#inv-add-form'); if (!f) return;
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) { updateAddCardGradeRow(); updateAddCardBasis(); }
}
function updateAddCardGradeRow(){
  const graded = $('#af-cond').value === 'graded';
  const row = $('#af-grade-row'); if (row) row.style.display = graded ? '' : 'none';
}
function afNum(id){ const v=parseFloat($(id).value); return isFinite(v)?v:0; }
// Convert entered per-card OR total amounts into PER-UNIT values (stored internally per-unit).
// If mode==='total', the entered figures cover all copies, so divide by qty.
function afPerUnit(){
  const qty = Math.max(1, parseInt($('#af-qty').value,10)||1);
  const mode = ($('#af-price-mode') && $('#af-price-mode').value) || 'each';
  const div = mode === 'total' ? qty : 1;
  return {
    qty,
    price: afNum('#af-price')/div,
    shipping: afNum('#af-ship')/div,
    tax: afNum('#af-tax')/div,
    other: afNum('#af-other')/div
  };
}
function updateAddCardBasis(){
  const u = afPerUnit();
  // probe with qty so the preview shows the REAL total (matches what gets saved)
  const probe = { id:null, qty:u.qty, acq:{price:u.price, shipping:u.shipping, tax:u.tax, other:u.other}, grading:{} };
  const totalBasis = Inventory.costBasisTotal(probe);   // × qty — the true total
  const perUnitBasis = Inventory.costBasis(probe);       // one copy
  const be = Inventory.breakEven(probe);                 // break-even per card
  const el = $('#af-basis');
  if (el) el.innerHTML =
    `<div class="inv-sum-row"><span>Total cost (${u.qty} card${u.qty===1?'':'s'})</span><b>${money(totalBasis)}</b></div>`+
    `<div class="inv-sum-row"><span>Per card</span><b>${money(perUnitBasis)}</b></div>`+
    `<div class="inv-sum-row"><span>Break-even each (after fees)</span><b>${money(be)}</b></div>`;
}
function saveAddCard(){
  const name = $('#af-name').value.trim();
  if (!name) { alert('Enter a card name.'); return; }
  const cond = $('#af-cond').value;
  const u = afPerUnit();
  const card = Collection.upsertCard({ name, number:$('#af-number').value.trim(), set:$('#af-set').value.trim(), variant:'', language:'EN', image: _afPhoto || '' });
  const it = Collection.addItem(card.key, {
    condition: cond,
    company: cond==='graded' ? $('#af-company').value : null,
    grade: cond==='graded' ? ($('#af-grade').value.trim()||null) : null,
    qty: u.qty,
    valSource: 'ebay'
  });
  Collection.updateItem(it.id, {
    // stored PER-UNIT (costBasisTotal multiplies by qty); toggle already normalized above
    acq: { price:Inventory.round2(u.price), shipping:Inventory.round2(u.shipping), tax:Inventory.round2(u.tax), other:Inventory.round2(u.other), date:$('#af-date').value||Collection.today() },
    status: 'in_inventory'
  });
  // reset + hide
  ['#af-name','#af-number','#af-set','#af-qty','#af-grade','#af-price','#af-ship','#af-tax','#af-other'].forEach(id=>{ if($(id)) $(id).value=''; });
  _afPhoto=''; if($('#af-photo-preview')) $('#af-photo-preview').innerHTML='🃏';
  $('#inv-add-form').classList.add('hidden');
  renderInventory();
}

/* ---------- Business Dashboard (Phase 5, #17) ---------- */
function renderBizDashboard(){
  if (!window.BridgeExport || !window.BridgeExport.dashboard) return;
  const d = BridgeExport.dashboard();
  const totEl = $('#dash-total'); if (totEl) totEl.textContent = money(d.totalInvBasis);
  const subEl = $('#dash-sub');
  if (subEl) subEl.textContent = `${d.cards} card${d.cards===1?'':'s'} · ${d.sealedCount} sealed · realized profit ${money(d.realizedProfit)}`;
  const grid = $('#dash-grid');
  if (grid) {
    const cell = (label, val, cls='') => `<div class="dash-cell"><div class="dash-c-lbl">${label}</div><div class="dash-c-val ${cls}">${val}</div></div>`;
    grid.innerHTML =
      cell('Card inventory', money(d.cardBasis)) +
      cell('Sealed inventory', money(d.sealedValue)) +
      cell('Est. card value', d.cardEst>0?money(d.cardEst):'—') +
      cell('Unrealized', d.cardEst>0?money(d.unrealizedProfit):'—', d.unrealizedProfit>=0?'pos':'neg') +
      cell('Realized revenue', money(d.realizedRevenue)) +
      cell('Realized profit', money(d.realizedProfit), d.realizedProfit>=0?'pos':'neg') +
      cell('Grading spend', money(d.gradingSpend)) +
      cell('Product spend', money(d.productSpend)) +
      cell('Cards', d.cards) +
      cell('At grading', d.atGrading) +
      cell('Listed', d.listed) +
      cell('Sold', d.soldCount);
  }
}

// Refresh prices for every held (unsold) card via the cloud (queues each, records history).
// Is a card's latest recorded price older than N days (or missing)? -> needs update.
function cardIsStale(cardKey, days){
  const cutoff = Date.now() - days*24*60*60*1000;
  let newest = 0;
  ['ebay','tcgplayer','130point'].forEach(src=>{
    ['RAW','PSA','BGS','CGC','SGC'].forEach(co=>{
      const grades = co==='RAW' ? [null] : ['10','9.5','9'];
      grades.forEach(g=>{
        const h = Collection.priceHistory(cardKey, src, co, g);
        if (h.length){ const t = new Date(h[h.length-1].t || h[h.length-1].date || 0).getTime(); if (t>newest) newest=t; }
      });
    });
  });
  return newest < cutoff;   // never priced OR older than the cutoff
}

async function refreshAllHeld(){
  if (!window.Cloud || !Cloud.configured()) { alert('Cloud not set up. Paste your Firebase URL in cloud.js.'); return; }
  const held = (Collection.items()||[]).filter(it => it.status!=='sold');
  const seen = {}; const stale = [];
  held.forEach(it => {
    const c = Collection.getCard(it.cardKey); if (!c) return;
    const k = Cloud.keyFor(c.name, c.number); if (seen[k]) return; seen[k]=1;
    if (cardIsStale(it.cardKey, 7)) stale.push(c);   // only stale/never-priced (>7 days)
  });
  const note = $('#dash-refresh-note');
  if (!stale.length) { if(note) note.textContent = 'All held cards updated within 7 days — nothing to fetch. ✓'; return; }
  for (const c of stale) { try { await Cloud.enqueue(c.name, c.number, { set:c.set, variant:c.variant }); } catch(e){} }
  if (note) note.textContent = `📲 Requested ${stale.length} stale card${stale.length===1?'':'s'} (fresh ones skipped). Open the DBZ extension in Chrome → click Fetch. It works through them slowly.`;
}

/* ---------- Grading workflow (Phase 4) ---------- */
let gradeEditingId = null;
let gradeMode = 'send'; // 'send' or 'complete'
function openGradeSend(id){
  const it = invFindItem(id); if (!it) return;
  gradeEditingId = id; gradeMode = 'send';
  $('#grade-ed-title').textContent = 'Send to Grading';
  $('#grade-send-fields').classList.remove('hidden');
  $('#grade-complete-fields').classList.add('hidden');
  $('#grade-save-btn').textContent = 'Send to Grading';
  // prefill from existing grading if any
  const g = it.grading || {};
  $('#gr-company').value = it.company || 'PSA';
  $('#gr-subno').value = g.submissionNo || '';
  $('#gr-subdate').value = g.submittedDate || Collection.today();
  $('#gr-fee').value = g.fee || '';
  $('#gr-shipto').value = g.shipTo || '';
  $('#gr-shipback').value = g.shipBack || '';
  $('#gr-ins').value = g.insurance || '';
  $('#gr-other').value = g.other || '';
  updateGradeBasis();
  $('#grade-editor').classList.remove('hidden');
}
function openGradeComplete(id){
  const it = invFindItem(id); if (!it) return;
  gradeEditingId = id; gradeMode = 'complete';
  $('#grade-ed-title').textContent = 'Grading Returned';
  $('#grade-send-fields').classList.add('hidden');
  $('#grade-complete-fields').classList.remove('hidden');
  $('#grade-save-btn').textContent = 'Save Grade';
  $('#gr-grade').value = it.grade || '';
  $('#gr-retdate').value = Collection.today();
  $('#gr-extraship').value = '';
  $('#gr-extraother').value = '';
  updateGradeBasis();
  $('#grade-editor').classList.remove('hidden');
}
function closeGradeEditor(){ $('#grade-editor').classList.add('hidden'); gradeEditingId = null; }
function grNum(id){ const v=parseFloat($(id).value); return isFinite(v)?v:0; }
function updateGradeBasis(){
  const it = invFindItem(gradeEditingId); if (!it) return;
  // build a probe reflecting current inputs
  let probe;
  if (gradeMode === 'send') {
    probe = { acq: it.acq||{}, grading: { fee:grNum('#gr-fee'), shipTo:grNum('#gr-shipto'), shipBack:grNum('#gr-shipback'), insurance:grNum('#gr-ins'), other:grNum('#gr-other') } };
  } else {
    const g = { ...(it.grading||{}) };
    probe = { acq: it.acq||{}, grading: { ...g, shipBack:(+g.shipBack||0)+grNum('#gr-extraship'), other:(+g.other||0)+grNum('#gr-extraother') } };
  }
  const basis = Inventory.costBasis(probe);
  const be = Inventory.breakEven(probe);
  const el = $('#grade-basis');
  if (el) el.innerHTML = `<div class="inv-sum-row"><span>New cost basis</span><b>${money(basis)}</b></div>`+
                         `<div class="inv-sum-row"><span>Break-even (after fees)</span><b>${money(be)}</b></div>`;
}
function saveGradeEditor(){
  const it = invFindItem(gradeEditingId); if (!it) { closeGradeEditor(); return; }
  let patch;
  if (gradeMode === 'send') {
    patch = Inventory.sendToGradingPatch({
      company: $('#gr-company').value, submissionNo: $('#gr-subno').value.trim(), submittedDate: $('#gr-subdate').value||null,
      fee: grNum('#gr-fee'), shipTo: grNum('#gr-shipto'), shipBack: grNum('#gr-shipback'), insurance: grNum('#gr-ins'), other: grNum('#gr-other')
    });
  } else {
    patch = Inventory.completeGradingPatch(it, {
      grade: $('#gr-grade').value.trim(), returnedDate: $('#gr-retdate').value||null,
      extraShip: grNum('#gr-extraship'), extraOther: grNum('#gr-extraother')
    });
  }
  Collection.updateItem(gradeEditingId, patch);
  closeGradeEditor();
  renderInventory();
}

/* ---------- Sealed Products + Rip Sessions (Phase 3) ---------- */
let _pfPhoto = '';
function renderProducts(){
  // populate type dropdown once
  const typeSel = $('#pf-type');
  if (typeSel && !typeSel.options.length && window.Products) Products.TYPES.forEach(t=>{ const o=document.createElement('option'); o.value=t; o.textContent=t; typeSel.appendChild(o); });

  const listEl = $('#prod-list');
  if (!listEl || !window.Products) return;
  const prods = Products.products();
  if (!prods.length) { listEl.innerHTML = `<p class="hint">No sealed products yet. Tap "+ Buy Sealed Product" to add boxes, packs, blisters, etc.</p>`; return; }

  listEl.innerHTML = prods.map(p => {
    const pr = Products.productProfit(p.id);
    const canOpen = p.qty > 0;
    let profitLine = '';
    if (p.opened > 0 && pr) {
      profitLine = `<div class="inv-item-profit"><span class="${pr.projectedProfit>=0?'pos':'neg'}">Opened ${pr.openedUnits}: pulls ${pr.pulls} · sold ${money(pr.soldRevenue)} · remaining ${money(pr.remainingValue)} · proj. profit ${money(pr.projectedProfit)}${pr.roi!=null?` (${pr.roi}%)`:''}</span></div>`;
    }
    const sess = Products.sessionsForProduct(p.id);
    const renderSess = (s, closed) => {
      const items = (Collection.items()||[]);
      const pulls = (s.cardItemIds||[]).map(id=>items.find(x=>x.id===id)).filter(Boolean);
      const pullList = pulls.map(it=>{
        const c = Collection.getCard(it.cardKey)||{};
        const soldTag = it.status==='sold' ? ` · <span class="pos">sold ${money((it.sale&&it.sale.price)||0)}</span>` : '';
        return `<div class="prod-pull-row">• ${escapeHtmlSafe(c.name||it.cardKey)} — basis ${money(Inventory.costBasis(it))}${soldTag}</div>`;
      }).join('');
      const controls = closed
        ? `<span class="prod-addpull" data-action="prod-reopen" data-id="${s.id}">↩ reopen</span>`
        : `<span class="prod-addpull" data-action="prod-add-pull" data-id="${s.id}">+ add pull</span>`+
          (pulls.length ? ` <span class="prod-addpull" data-action="prod-close" data-id="${s.id}">✓ done pulling</span>` : '');
      return `<div class="prod-sess">🎴 ${escapeHtmlSafe(s.unitLabel)} — ${s.cardItemIds.length} pull${s.cardItemIds.length===1?'':'s'} ${controls}</div>${pullList}`;
    };
    const allSess = Products.sessionsForProduct(p.id);
    const openSess = allSess.filter(s=>!s.closed);
    const closedSess = allSess.filter(s=>s.closed);
    let sessLines = openSess.map(s=>renderSess(s,false)).join('');
    if (closedSess.length) {
      sessLines += `<details class="prod-closed"><summary>📦 Closed packs (${closedSess.length})</summary>${closedSess.map(s=>renderSess(s,true)).join('')}</details>`;
    }
    return `<div class="inv-item">
      <div class="inv-item-head">
        <div class="inv-thumb">${p.image?`<img src="${p.image}" alt="">`:'📦'}</div>
        <div class="inv-item-main">
          <div class="inv-item-name">${escapeHtmlSafe(p.name)}</div>
          <div class="inv-item-sub">${escapeHtmlSafe(p.type)}${p.set?' · '+escapeHtmlSafe(p.set):''} · sealed ${p.qty} / opened ${p.opened} · ${money(p.costPerUnit)}/unit</div>
        </div>
        <div class="inv-item-nums"><div class="inv-basis">${money(Products.totalCost(p.cost))}</div></div>
      </div>
      ${profitLine}
      ${sessLines}
      ${p.opened>0 ? (()=>{ const r=Products.boxRecovery(p.id); if(!r) return '';
        const bulkLines=(p.bulkSales||[]).map(b=>`<div class="prod-bulk-row">💵 Bulk sold ${money(b.amount)}${b.note?' · '+escapeHtmlSafe(b.note):''} <span class="prod-bulk-del" data-action="prod-bulk-del" data-id="${p.id}" data-sid="${b.id}">✕</span></div>`).join('');
        return `<div class="prod-recovery">
          <div class="prod-rec-bar"><div class="prod-rec-fill" style="width:${Math.min(100,r.openedCost?Math.round(r.recovered/r.openedCost*100):0)}%"></div></div>
          <div class="prod-rec-txt">Recovered <b>${money(r.recovered)}</b> of ${money(r.openedCost)} · <b>${money(r.remaining)}</b> left${r.unsoldKeepers>0?` across ${r.unsoldKeepers} keeper${r.unsoldKeepers===1?'':'s'} (${money(r.unsoldKeepers?r.remaining/r.unsoldKeepers:0)} each)`:' · all recovered ✓'}</div>
          ${bulkLines}
          <button class="btn-secondary block" data-action="prod-sell-bulk" data-id="${p.id}">💵 Sell bulk from this ${escapeHtmlSafe(p.type||'product')}</button>
        </div>`; })() : ''}
      ${canOpen ? `<button class="btn-secondary block inv-edit-btn" data-action="prod-open" data-id="${p.id}">📦 Open a unit</button>` : ''}
    </div>`;
  }).join('');
}

function toggleProdForm(){
  const f = $('#prod-add-form'); if (!f) return;
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) updateProdPerUnit();
}
function prodNum(id){ const v=parseFloat($(id).value); return isFinite(v)?v:0; }
function updateProdPerUnit(){
  const qty = Math.max(1, parseInt($('#pf-qty').value,10)||1);
  const tot = prodNum('#pf-price')+prodNum('#pf-ship')+prodNum('#pf-tax');
  const el = $('#pf-perunit');
  if (el) el.innerHTML = `<div class="inv-sum-row"><span>Total cost</span><b>${money(Math.round(tot*100)/100)}</b></div>`+
                         `<div class="inv-sum-row"><span>Cost per unit</span><b>${money(Math.round(tot/qty*100)/100)}</b></div>`;
}
function sellBulkFromProduct(productId){
  if (!window.Products) return;
  const p = Products.getProduct(productId); if (!p) return;
  const raw = prompt(`Sell bulk from "${p.name}"\n\nHow much did the bulk sell for? (this reduces the box's remaining cost across your unsold keepers)`, '');
  if (raw === null) return;
  const amt = parseFloat(String(raw).replace(/[^0-9.]/g,''));
  if (!isFinite(amt) || amt <= 0) { alert('Enter a dollar amount greater than 0.'); return; }
  Products.addBulkSale(productId, amt, '');
  renderProducts(); renderInventory();
}
function saveProduct(){
  if (!window.Products) return;
  const name = $('#pf-name').value.trim();
  if (!name) { alert('Enter a product name.'); return; }
  Products.addProduct({
    name, set:$('#pf-set').value.trim(), type:$('#pf-type').value,
    qty: parseInt($('#pf-qty').value,10)||1,
    price: prodNum('#pf-price'), shipping: prodNum('#pf-ship'), tax: prodNum('#pf-tax'),
    image: _pfPhoto || ''
  });
  // reset + hide
  ['#pf-name','#pf-set','#pf-qty','#pf-price','#pf-ship','#pf-tax'].forEach(id=>{ if($(id)) $(id).value=''; });
  _pfPhoto=''; if($('#pf-photo-preview')) $('#pf-photo-preview').innerHTML='📦';
  $('#prod-add-form').classList.add('hidden');
  renderProducts();
}
// Open a unit -> create a rip session, then immediately let the user add pulls.
function openProductUnit(productId){
  if (!window.Products) return;
  const p = Products.getProduct(productId); if (!p) return;
  const label = prompt(`Label this opened unit (e.g. "${p.name} #${p.opened+1}"):`, `${p.name} #${p.opened+1}`);
  if (label === null) return;
  const sess = Products.openUnit(productId, label.trim() || undefined);
  if (!sess) { alert('No sealed units left to open.'); return; }
  renderProducts();
  alert(`Opened. Now tap "+ add pull" under "${sess.unitLabel}" to record each card you pulled.`);
}
// Add a pulled card to a session: creates a Collection card+item seeded with the unit's allocated cost.
function addPullToSession(sessionId){
  if (!window.Products || !window.Collection) return;
  const sess = Products.getSession(sessionId); if (!sess) return;
  const prod = Products.getProduct(sess.productId);
  // Offer: type it, or scan it.
  const wantScan = confirm('Add this pull by SCANNING the card?\n\nOK = Scan   ·   Cancel = Type it in');
  if (wantScan) {
    // Route to the Scan tab; when the scan is confirmed, it'll be added as a pull to this session.
    setPullTarget({ sessionId });
    resetScanForNext();
    showView('scan');
    return;
  }
  const nm = prompt('Pulled card name:'); if (!nm) return;
  const code = prompt('Card number/code (optional):') || '';
  addPullCard(sessionId, { name: nm.trim(), number: code.trim(), set:(prod&&prod.set)||'', variant:'', rarity:'', language:'EN' });
}
// Shared: create a pull card + owned item tied to a session (used by type AND scan paths).
function addPullCard(sessionId, fields){
  const sess = Products.getSession(sessionId); if (!sess) return;
  const card = Collection.upsertCard({ name:fields.name, number:fields.number||'', set:fields.set||'',
    variant:fields.variant||'', rarity:fields.rarity||'', language:fields.language||'EN',
    image:fields.image||'', dbVerified: !!fields.dbVerified });
  const it = Collection.addItem(card.key, { condition:'raw', qty:1, valSource:'ebay', purchaseCost:0 });
  Collection.updateItem(it.id, {
    sourceProductId: sess.productId, sourceSessionId: sessionId,
    acq: { price: 0, shipping:0, tax:0, other:0, date: Products.today() },
    status: 'in_inventory'
  });
  Products.addPullToSession(sessionId, it.id);
  renderProducts();
  renderInventory();
  return it;
}

function renderCollection(){
  const val = Collection.collectionValue();
  const src = (Collection.settings().valuationSource || 'ebay').toUpperCase();
  $('#col-value').textContent = money(val);
  $('#col-value-sub').textContent = `${Collection.totalCards()} card${Collection.totalCards()===1?'':'s'} · source: ${src}`;

  // performance windows
  const perfEl = $('#col-perf'); perfEl.innerHTML = '';
  PERF_WINDOWS.forEach(w => {
    const p = Collection.perf(w.k);
    const box = document.createElement('div'); box.className = 'perf-box';
    if (!p) { box.innerHTML = `<div class="pf-lbl">${w.label}</div><div class="pf-val">—</div>`; }
    else {
      const up = p.dollar >= 0;
      box.innerHTML = `<div class="pf-lbl">${w.label}</div>
        <div class="pf-val ${up?'pos':'neg'}">${up?'+':''}${money(p.dollar)}</div>
        <div class="pf-pct ${up?'pos':'neg'}">${up?'+':''}${p.pct.toFixed(2)}%</div>`;
    }
    perfEl.appendChild(box);
  });

  drawCollectionChart();
  renderHoldings();
}

function snapsForRange(){
  const snaps = Collection.snapshots();
  if (!snaps.length) return [];
  if (colRange === 'all') return snaps;
  const now = new Date();
  let refDate;
  if (colRange === 'ytd') refDate = `${now.getFullYear()}-01-01`;
  else { const d = new Date(now); d.setDate(d.getDate() - (+colRange)); refDate = d.toISOString().slice(0,10); }
  return snaps.filter(s => s.date >= refDate);
}

function drawChart(canvasId, points, readoutId, dateFmt){
  const canvas = $('#'+canvasId); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR (iOS 3x can balloon the buffer)
  const wrap = canvas.parentElement;
  let cssW = wrap && wrap.getBoundingClientRect ? Math.floor(wrap.getBoundingClientRect().width) : 0;
  // If the pane isn't laid out yet (hidden/mid-transition on iOS), width is 0 — defer one frame.
  if (!cssW || cssW < 40) {
    if (!canvas._retry) { canvas._retry = 1; requestAnimationFrame(() => { canvas._retry = 0; drawChart(canvasId, points, readoutId, dateFmt); }); }
    return;
  }
  cssW = Math.min(cssW, 560);                 // clamp to a sane max width
  const cssH = canvasId === 'cd-chart' ? 160 : 180;   // fixed display height (matches CSS, never grows)
  // Do NOT set canvas.style.* here — CSS owns the display size (prevents iOS height feedback loop).
  // Only set the drawing buffer to match display size × DPR.
  canvas.width = Math.round(cssW*dpr); canvas.height = Math.round(cssH*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,cssW,cssH);
  const pad = {l:8,r:8,t:14,b:14}; const w = cssW-pad.l-pad.r, h = cssH-pad.t-pad.b;
  if (!points.length) { ctx.fillStyle='#a86a63'; ctx.font='13px -apple-system,sans-serif'; ctx.textAlign='center'; ctx.fillText('No history yet — refresh prices to start tracking',cssW/2,cssH/2); return; }
  const vals = points.map(p=>p.value); let min=Math.min(...vals), max=Math.max(...vals);
  if (min===max){ max+=1; min-=1; }
  const n = Math.max(points.length-1,1);
  const px = i => pad.l+(i/n)*w; const py = v => pad.t+(1-(v-min)/(max-min))*h;
  const end = vals[vals.length-1], start = vals[0];
  const col = end>=start ? '#38d17a' : '#ff4b3e';
  const grad = ctx.createLinearGradient(0,pad.t,0,pad.t+h);
  grad.addColorStop(0, end>=start?'rgba(56,209,122,.25)':'rgba(255,75,62,.25)'); grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(px(0),py(vals[0])); points.forEach((p,i)=>ctx.lineTo(px(i),py(p.value)));
  ctx.lineTo(px(n),pad.t+h); ctx.lineTo(px(0),pad.t+h); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(px(0),py(vals[0])); points.forEach((p,i)=>ctx.lineTo(px(i),py(p.value)));
  ctx.strokeStyle=col; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.stroke();
  ctx.beginPath(); ctx.arc(px(n),py(end),4,0,Math.PI*2); ctx.fillStyle=col; ctx.fill();
  const ro = $('#'+readoutId);
  if (ro){ const d=end-start, pct=start!==0?(d/start*100):0; const up=d>=0;
    ro.innerHTML = `<span>${points[points.length-1].date}</span> · <b>${money(end)}</b> · <span class="${up?'pos':'neg'}">${up?'+':''}${money(d)} (${up?'+':''}${pct.toFixed(1)}%)</span>`; }
}

function drawCollectionChart(){
  const pts = snapsForRange().map(s => ({ date:s.date, value:s.value }));
  drawChart('col-chart', pts, 'col-chart-readout');
}

function renderHoldings(){
  const list = $('#holdings-list'); list.innerHTML = '';
  const its = Collection.items();
  $('#holdings-empty').classList.toggle('hidden', its.length>0);
  // group identical cards (same card + condition + grade) into one holding entry
  const groups = new Map();
  its.forEach(it => {
    const k = [it.cardKey, it.condition||'raw', it.company||'', it.grade||''].join('||');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  });
  [...groups.values()].forEach(entries => {
    const it = entries[0];
    const card = Collection.getCard(it.cardKey) || {};
    const cond = it.condition==='graded' ? `${it.company} ${it.grade}` : 'Raw';
    const totalQty = entries.reduce((s,x)=>s+(x.qty||1),0);
    // total value across all copies in the group
    let tv = 0, anyPrice = false;
    entries.forEach(x => { const v = Collection.itemValue(x); if (v!=null){ tv += v; anyPrice = true; } });
    const uv = anyPrice && totalQty ? tv/totalQty : null;
    const li = document.createElement('li'); li.className='holding-card';
    li.innerHTML = `
      <div class="hc-top"><span class="hc-thumb">${card.image?`<img src="${card.image}" alt="">`:'🃏'}</span><span class="hc-name">${esc(card.name||'Unknown')}</span><span class="hc-cond">${esc(cond)} ×${totalQty}</span></div>
      <div class="hc-meta">${esc(card.number||'')}${card.set?` · ${esc(card.set)}`:''}${entries.length>1?` · ${entries.length} entries`:''}</div>
      <div class="hc-val">${uv==null?'<span class="neg">No price recorded</span>':`${money(Math.round(uv*100)/100)} ea → <b>${money(Math.round(tv*100)/100)}</b>`}</div>
      <div class="hc-actions">
        <button class="mini-btn" data-cd="${esc(it.cardKey)}">Details</button>
        <button class="mini-btn" data-remove-item="${it.id}">Remove</button>
      </div>`;
    li.querySelector('[data-cd]').addEventListener('click', ()=>openCardDetail(it.cardKey));
    li.querySelector('[data-remove-item]').addEventListener('click', ()=>removeHolding(it.id, card.name));
    list.appendChild(li);
  });
}

function removeHolding(itemId, name){
  const reason = prompt(`Remove "${name}" — reason? (sold / traded / lost / given away / damaged / other)`, 'sold');
  if (reason === null) return;
  let salePrice = null;
  if (/sold/i.test(reason)) { const sp = prompt('Sale price (optional):', ''); if (sp) salePrice = parseFloat(sp)||null; }
  Collection.removeItem(itemId, { reason: reason.trim().toLowerCase(), salePrice });
  renderCollection();
}

/* ---------- card detail ---------- */
const GRADE_ROWS = [
  {co:'PSA',g:'10'},{co:'PSA',g:'9.5'},{co:'PSA',g:'9'},
  {co:'BGS',g:'10'},{co:'BGS',g:'9.5'},{co:'BGS',g:'9'},
  {co:'CGC',g:'10'},{co:'CGC',g:'9.5'},{co:'CGC',g:'9'}
];
const PRICE_SOURCES = ['tcgplayer','ebay','130point'];

// BULK cloud->app feed: pull EVERY card's cloud prices into Collection in one go.
// Uses the cloud we set up — so prices fetched by the extension flow into the whole app
// without opening each card. Returns how many cards got new data.
async function syncAllCloudPrices(){
  if (!window.Cloud || !Cloud.configured()) return 0;
  const cards = Collection.allCards();
  const keys = Object.keys(cards);
  let updated = 0;
  const v = s => (s && s.trimmedAvg != null) ? s.trimmedAvg : null;
  for (const key of keys) {
    const c = cards[key];
    let got=null; try { got = await Cloud.getPrice(Cloud.keyFor(c.name, c.number)); } catch(e){}
    if (!got || !got.when) continue;
    if (_lastSynced[key] === got.when) continue;   // already have this snapshot
    _lastSynced[key] = got.when;
    let recorded=false;
    ['ebay','tcgplayer','130point'].forEach(src=>{
      const node=got[src]; if(!node) return;
      if (v(node.raw)!=null){ Collection.recordPrice(key, src, 'RAW', null, v(node.raw), node.raw); recorded=true; }
      ['PSA','BGS','CGC','SGC'].forEach(co => { if(!node[co])return; Object.keys(node[co]).forEach(g=>{ const p=v(node[co][g]); if(p!=null){ Collection.recordPrice(key, src, co, g, p, node[co][g]); recorded=true; } }); });
    });
    if (recorded) updated++;
  }
  if (updated) Collection.snapshotNow();
  return updated;
}

// One-shot: read this card's cloud prices; if any are newer than what we have, record + re-render.
let _lastSynced = {};
async function syncCloudPricesForCard(key){
  if (!window.Cloud || !Cloud.configured()) return;
  const card = Collection.getCard(key); if (!card) return;
  try {
    const got = await Cloud.getPrice(Cloud.keyFor(card.name, card.number));
    if (!got || !got.when) return;
    if (_lastSynced[key] === got.when) return;   // already synced this exact snapshot
    _lastSynced[key] = got.when;
    const v=s=>(s&&s.trimmedAvg!=null)?s.trimmedAvg:null;
    let recorded=false;
    ['ebay','tcgplayer','130point'].forEach(src=>{
      const node=got[src]; if(!node) return;
      if (v(node.raw)!=null){ Collection.recordPrice(key, src, 'RAW', null, v(node.raw), node.raw); recorded=true; }
      ['PSA','BGS','CGC','SGC'].forEach(co => { if(!node[co])return; Object.keys(node[co]).forEach(g=>{ const p=v(node[co][g]); if(p!=null){ Collection.recordPrice(key, src, co, g, p, node[co][g]); recorded=true; } }); });
    });
    if (recorded && currentCardKey === key) { Collection.snapshotNow(); openCardDetail(key); }
  } catch (e) {}
}

function openCardDetail(key){
  currentCardKey = key;
  const card = Collection.getCard(key) || {};
  $('#cd-name').textContent = card.name || 'Card';
  const th = $('#cd-thumb'); if (th) th.innerHTML = cardThumbHtml(card);
  $('#cd-meta').textContent = [card.number, card.set, card.variant, card.rarity, card.language].filter(Boolean).join(' · ');

  // raw table
  const rawRows = PRICE_SOURCES.map(src => {
    const p = Collection.latestPrice(key, src, 'RAW', null);
    return `<tr><td>${srcLabel(src)}</td><td class="pt-price">${p==null?'<span class="na">N/A</span>':money(p)}</td></tr>`;
  }).join('');
  $('#cd-raw-table').innerHTML = `<tr><th>Source</th><th>Raw price</th></tr>${rawRows}`;

  // graded table
  let gh = `<tr><th>Grade</th>${PRICE_SOURCES.map(s=>`<th>${srcLabel(s)}</th>`).join('')}</tr>`;
  GRADE_ROWS.forEach(r => {
    const cells = PRICE_SOURCES.map(src => { const p = Collection.latestPrice(key, src, r.co, r.g); return `<td class="pt-price">${p==null?'<span class="na">N/A</span>':money(p)}</td>`; }).join('');
    gh += `<tr><td class="grade-cell">${r.co} ${r.g}</td>${cells}</tr>`;
  });
  $('#cd-graded-table').innerHTML = gh;

  // card price history chart (use eBay raw as the tracked line by default)
  const hist = Collection.priceHistory(key, 'ebay', 'RAW', null).map(h => ({ date:h.date, value:h.price }));
  drawChart('cd-chart', hist, 'cd-chart-readout');

  showView('carddetail');
}
function srcLabel(s){ return {tcgplayer:'TCGplayer', ebay:'eBay', '130point':'130point'}[s]||s; }

function addCurrentToCollection(){
  if (!currentCardKey) return;
  const cond = confirm('Is this card GRADED?\n\nOK = Graded   |   Cancel = Raw/Ungraded') ? 'graded' : 'raw';
  let company=null, grade=null;
  if (cond==='graded'){
    company = (prompt('Grading company? (PSA / BGS / CGC)', 'PSA')||'PSA').toUpperCase().trim();
    if (!['PSA','BGS','CGC'].includes(company)) company='PSA';
    grade = (prompt('Grade? (10 / 9.5 / 9)', '10')||'10').trim();
  }
  const qty = parseInt(prompt('Quantity?', '1')) || 1;
  const cost = prompt('Purchase price each (optional):', '');
  Collection.addItem(currentCardKey, { condition:cond, company, grade, qty,
    valSource: Collection.settings().valuationSource||'ebay',
    purchaseCost: cost? parseFloat(cost): null });
  alert('Added to collection.');
  showView('inventory');
}

// refresh prices for the current detail card via the cloud (records history)
async function refreshCardPrices(){
  const card = Collection.getCard(currentCardKey); if (!card) return;
  if (!window.Cloud || !Cloud.configured()) { alert('Cloud not set up. Paste your Firebase URL in cloud.js.'); return; }
  try {
    // 1) request a price update (the extension fulfills it next time you open it in Chrome)
    await Cloud.enqueue(card.name, card.number, { set: card.set, variant: card.variant });
    // 2) also pull anything already in the cloud right now (in case it was fetched before)
    const key = Cloud.keyFor(card.name, card.number);
    let got=null; try{ got = await Cloud.getPrice(key); }catch(e){}
    const v=s=>(s&&s.trimmedAvg!=null)?s.trimmedAvg:null;
    let recorded=false;
    if (got) ['ebay','tcgplayer','130point'].forEach(src=>{
      const node=got[src]; if(!node) return;
      if (v(node.raw)!=null){ Collection.recordPrice(currentCardKey, src, 'RAW', null, v(node.raw), node.raw); recorded=true; }
      ['PSA','BGS','CGC','SGC'].forEach(co => { if(!node[co])return; Object.keys(node[co]).forEach(g=>{ const p=v(node[co][g]); if(p!=null){ Collection.recordPrice(currentCardKey, src, co, g, p, node[co][g]); recorded=true; } }); });
    });
    if (recorded) Collection.snapshotNow();
    openCardDetail(currentCardKey); // re-render
    alert(recorded
      ? '✓ Requested a fresh update AND loaded the latest saved prices.\nOpen the extension in Chrome to fetch newer ones.'
      : '📲 Price update requested.\nOpen the DBZ extension in Chrome — it will show this card as requested. Click "Fetch", then reopen this card here.');
  } catch(e){ alert('Cloud request failed. Check your internet.'); }
}

/* export/import collection */
function exportCollection(){
  const blob = new Blob([JSON.stringify(Collection.exportAll(),null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`dbz-collection-${Collection.today()}.json`; a.click(); URL.revokeObjectURL(url);
}
function importCollection(file){
  const r=new FileReader(); r.onload=e=>{ try{ Collection.importAll(JSON.parse(e.target.result)); renderCollection(); alert('Collection imported.'); }catch(err){ alert('Could not read that file.'); } }; r.readAsText(file);
}

/* ---------- events ---------- */
document.body.addEventListener('click', e => {
  // Tap a card image to enlarge it (before other handlers).
  const zoomEl = e.target.closest('[data-zoom]');
  if (zoomEl && zoomEl.dataset.zoom) {
    const zi = $('#img-zoom-img'); if (zi) zi.src = zoomEl.dataset.zoom;
    $('#img-zoom').classList.remove('hidden');
    e.stopPropagation(); return;
  }
  const a = e.target.closest('[data-action]'); const t = e.target.closest('[data-view]');
  if (a && a.dataset.action === 'img-zoom-close') { $('#img-zoom').classList.add('hidden'); return; }
  if (t) { showView(t.dataset.view); return; }
  if (!a) return;
  const map = {
    'start-cam': toggleCam,
    'capture': captureFromVideo,
    'to-calc': () => {
      state.scan.name = $('#f-name').value.trim();
      state.scan.code = $('#f-code').value.trim();
      $('#calc-name').textContent = state.scan.name || '—';
      $('#calc-code').textContent = state.scan.code || '';
      buildEbayLinks();
      showView('calc');
    },
    'calc': calcFlip,
    'save-card': saveCard,
    'scan-pick-alt': (el) => {
      const idx = +(el && el.dataset ? el.dataset.idx : -1);
      const r = state.scanResult;
      if (!r || !r.alternativeMatches || !r.alternativeMatches[idx]) return;
      const card = r.alternativeMatches[idx].card;
      $('#f-name').value = card.name || '';
      $('#f-code').value = card.number || '';
      if (state.scan) { state.scan.name = card.name || ''; state.scan.code = card.number || ''; }
    },
    'open-verify': () => openVerifyScreen(),
    'open-verify-list': () => openVerifyList(),
    'verify-list-close': () => { $('#verify-list-screen').classList.add('hidden'); },
    'verify-pick': (el) => verifyPickCard(el),
    'load-carddb': () => loadCardDbUI(),
    'img-diag': () => runImageDiag(),
    'verify-close': () => { $('#verify-screen').classList.add('hidden'); },
    'verify-confirm-business': () => confirmVerifiedCard('business'),
    'verify-confirm-collection': () => confirmVerifiedCard('collection'),
    'scan-to-business': () => {
      const name = $('#f-name').value.trim(); const code = $('#f-code').value.trim();
      if (!name) { alert('Enter a card name first.'); return; }
      const card = Collection.upsertCard({ name, number: code, set:'', variant:'', language:'EN', image: (state.scan&&state.scan.image)||'' });
      const it = Collection.addItem(card.key, { condition:'raw', qty:1, valSource:'ebay' });
      Collection.updateItem(it.id, { status:'in_inventory', acq:{ price:0, shipping:0, tax:0, other:0, date:Collection.today() } });
      showView('inventory');
      openInvEditor(it.id);   // open editor so you type the buy price now
    },
    'scan-to-collection': () => {
      const name = $('#f-name').value.trim(); const code = $('#f-code').value.trim();
      if (!name) { alert('Enter a card name first.'); return; }
      const card = Collection.upsertCard({ name, number: code, set:'', variant:'', language:'EN', image: (state.scan&&state.scan.image)||'' });
      currentCardKey = card.key;
      showView('carddetail');
    },
    'rank-top': rankTop,
    'export-learn': exportCorrections,
    'review-corrections': toggleCorrections,
    'cd-back': () => showView('inventory'),
    'cd-add': addCurrentToCollection,
    'cd-refresh': refreshCardPrices,
    'col-export': exportCollection,
    'track-card': () => {
      // create/update the card record from the scanned/searched identity
      const card = Collection.upsertCard({ name: state.scan.name, number: state.scan.code, set: '', variant: '', language: 'EN' });
      // seed any prices the user entered on the Flip screen into history (raw + current grader's grades)
      const grader = GRADERS[$('#grader-select').value].name.split(' ')[0];
      const raw = num('#p-raw'); if (raw>0) Collection.recordPrice(card.key, 'ebay', 'RAW', null, raw);
      $$('.grade-price').forEach(inp => { const v = parseFloat(inp.value); if (isFinite(v)&&v>0) Collection.recordPrice(card.key,'ebay',grader,inp.dataset.grade,v); });
      openCardDetail(card.key);
    }
  };
  // range buttons for the collection chart
  const rb = e.target.closest('.range-btn');
  if (rb) { colRange = rb.dataset.range; $$('#col-range .range-btn').forEach(x=>x.classList.toggle('active', x===rb)); drawCollectionChart(); return; }
  // inventory: expand/collapse a card's min-sell table
  if (a.dataset.action === 'inv-expand') { invExpanded = (invExpanded === a.dataset.id) ? null : a.dataset.id; renderInventory(); return; }
  if (a.dataset.action === 'inv-edit') { openInvEditor(a.dataset.id); return; }
  if (a.dataset.action === 'inv-sell') { sellInvItem(a.dataset.id); return; }
  if (a.dataset.action === 'inv-ed-close') { closeInvEditor(); return; }
  if (a.dataset.action === 'inv-ed-save') { saveInvEditor(); return; }
  if (a.dataset.action === 'bridge-copy') { copyBridgeData(); return; }
  if (a.dataset.action === 'prod-add-open') { toggleProdForm(); return; }
  if (a.dataset.action === 'prod-save') { saveProduct(); return; }
  if (a.dataset.action === 'prod-open') { openProductUnit(a.dataset.id); return; }
  if (a.dataset.action === 'prod-add-pull') { addPullToSession(a.dataset.id); return; }
  if (a.dataset.action === 'prod-close') { Products.closeSession(a.dataset.id); renderProducts(); return; }
  if (a.dataset.action === 'prod-reopen') { Products.reopenSession(a.dataset.id); renderProducts(); return; }
  if (a.dataset.action === 'prod-sell-bulk') { sellBulkFromProduct(a.dataset.id); return; }
  if (a.dataset.action === 'prod-bulk-del') { Products.removeBulkSale(a.dataset.id, a.dataset.sid); renderProducts(); renderInventory(); return; }
  if (a.dataset.action === 'grade-send') { openGradeSend(a.dataset.id); return; }
  if (a.dataset.action === 'grade-complete') { openGradeComplete(a.dataset.id); return; }
  if (a.dataset.action === 'grade-ed-close') { closeGradeEditor(); return; }
  if (a.dataset.action === 'grade-ed-save') { saveGradeEditor(); return; }
  if (a.dataset.action === 'inv-add-open') { toggleAddCardForm(); return; }
  if (a.dataset.action === 'inv-add-save') { saveAddCard(); return; }
  if (a.dataset.action === 'backup-now') { backupNowUI(); return; }
  if (a.dataset.action === 'backup-download') { if(window.Backup) Backup.downloadBackup(); return; }
  if (map[a.dataset.action]) map[a.dataset.action](a);
});
// inventory filter + search
if ($('#inv-status-filter')) $('#inv-status-filter').addEventListener('change', e => { invStatusFilter = e.target.value; renderInventory(); });
if ($('#inv-search')) $('#inv-search').addEventListener('input', e => { invSearch = e.target.value; renderInventory(); });
// live basis preview in the editor
['#ed-acq-price','#ed-acq-ship','#ed-acq-tax','#ed-acq-other','#ed-grd-fee','#ed-grd-shipto','#ed-grd-shipback','#ed-grd-other'].forEach(id=>{
  const el = $(id); if (el) el.addEventListener('input', updateInvBasisPreview);
});
if ($('#ed-price-mode')) $('#ed-price-mode').addEventListener('change', updateInvBasisPreview);
if ($('#ed-photo')) $('#ed-photo').addEventListener('change', async e => { if (e.target.files[0]) { _edPhoto = await fileToThumb(e.target.files[0]); const pv=$('#ed-photo-preview'); if(pv) pv.innerHTML = _edPhoto?`<img src="${_edPhoto}" style="width:100%;height:100%;object-fit:cover">`:'🃏'; } e.target.value=''; });
// product form: live cost-per-unit preview
['#pf-qty','#pf-price','#pf-ship','#pf-tax'].forEach(id=>{ const el=$(id); if(el) el.addEventListener('input', updateProdPerUnit); });
if ($('#pf-photo')) $('#pf-photo').addEventListener('change', async e => { if (e.target.files[0]) { _pfPhoto = await fileToThumb(e.target.files[0]); const pv=$('#pf-photo-preview'); if(pv) pv.innerHTML = _pfPhoto?`<img src="${_pfPhoto}" style="width:100%;height:100%;object-fit:cover">`:'📦'; } e.target.value=''; });
// grading form: live basis preview
['#gr-fee','#gr-shipto','#gr-shipback','#gr-ins','#gr-other','#gr-extraship','#gr-extraother'].forEach(id=>{ const el=$(id); if(el) el.addEventListener('input', updateGradeBasis); });
// add-card form: condition toggle + live basis
if ($('#af-cond')) $('#af-cond').addEventListener('change', updateAddCardGradeRow);
['#af-price','#af-ship','#af-tax','#af-other','#af-qty'].forEach(id=>{ const el=$(id); if(el) el.addEventListener('input', updateAddCardBasis); });
if ($('#af-price-mode')) $('#af-price-mode').addEventListener('change', updateAddCardBasis);
$('#photo-input').addEventListener('change', e => { if (e.target.files[0]) ocrFromFile(e.target.files[0]); e.target.value = ''; });
$('#import-learn').addEventListener('change', e => { if (e.target.files[0]) importLearning(e.target.files[0]); e.target.value = ''; });
$('#col-import').addEventListener('change', e => { if (e.target.files[0]) importCollection(e.target.files[0]); e.target.value = ''; });
if ($('#backup-restore-file')) $('#backup-restore-file').addEventListener('change', e => { if (e.target.files[0]) restoreBackupFile(e.target.files[0]); e.target.value = ''; });
if ($('#af-scan')) $('#af-scan').addEventListener('change', e => { if (e.target.files[0]) scanIntoAddCard(e.target.files[0]); e.target.value = ''; });
if ($('#af-photo')) $('#af-photo').addEventListener('change', async e => { if (e.target.files[0]) { _afPhoto = await fileToThumb(e.target.files[0]); const pv=$('#af-photo-preview'); if(pv) pv.innerHTML = _afPhoto?`<img src="${_afPhoto}" style="width:100%;height:100%;object-fit:cover">`:'🃏'; } e.target.value=''; });
$('#grader-select').addEventListener('change', renderGradeInputs);
$('#service-select').addEventListener('change', applyServiceFee);

// DATA SAFETY: auto-restore if data is missing, auto-backup every 3 days. Runs before UI.
try { if (window.Backup) Backup.tick(); } catch (e) {}

// ONE-TIME: migrate old dbz.priceMemory raw/grade prices into the unified Collection store.
try {
  if (!localStorage.getItem('dbz.priceMemoryMigrated')) {
    const mem = JSON.parse(localStorage.getItem('dbz.priceMemory') || '{}');
    Object.keys(mem).forEach(k => {
      const parts = k.split('|'); const name = parts[0], code = parts[1], grader = (parts[2]||'').toUpperCase();
      if (!name) return;
      const d = mem[k] || {};
      const card = Collection.upsertCard({ name, number: code, set:'', variant:'', language:'EN' });
      if (d.raw != null && +d.raw > 0) Collection.recordPrice(card.key, 'ebay', 'RAW', null, +d.raw);
      if (d.grades) Object.keys(d.grades).forEach(g => { const v = +d.grades[g]; if (isFinite(v)&&v>0 && grader) Collection.recordPrice(card.key, 'ebay', grader, g, v); });
    });
    localStorage.setItem('dbz.priceMemoryMigrated', '1');
  }
} catch (e) {}

renderGradeInputs();

// If a pull scan was interrupted (reload/crash), only keep the pull target if
// its session still exists and is still open; otherwise discard it so a normal
// scan doesn't get wrongly attached to a stale pack.
try {
  if (state.pullTarget && state.pullTarget.sessionId) {
    const s = window.Products && Products.getSession(state.pullTarget.sessionId);
    if (!s || s.closed) setPullTarget(null);
  }
} catch (e) { setPullTarget(null); }

showView('scan');

// cosmetic icon splash on open (~1.3s)
showLoader('Powering up…');
setTimeout(hideLoader, 1300);
