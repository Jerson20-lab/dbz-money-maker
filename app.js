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
  saved: JSON.parse(localStorage.getItem('dbz.saved') || '[]')
};
function save() { localStorage.setItem('dbz.saved', JSON.stringify(state.saved)); }

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
}

/* ---------- navigation ---------- */
function showView(v) {
  $$('.pane').forEach(p => p.classList.remove('active'));
  $('#pane-' + v).classList.add('active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $('#view-title').textContent = { scan: 'Scan', calc: 'Flip', top: 'Top 10', saved: 'Saved' }[v];
  if (v === 'saved') renderSaved();
  if (v === 'top') rankTop();
}

/* ---------- camera + OCR ---------- */
let stream = null;
async function startCam() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('#cam'); v.srcObject = stream; await v.play();
    $('#cam-wrap').classList.remove('hidden');
    $('#capture-btn').classList.remove('hidden');
  } catch (e) {
    ocrStatus('Camera unavailable — use "Upload a photo" instead.', true);
  }
}
function stopCam() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

function ocrStatus(msg, err) {
  const el = $('#ocr-status'); el.classList.remove('hidden');
  el.textContent = msg; el.classList.toggle('err', !!err);
}

async function captureFromVideo() {
  const v = $('#cam'); if (!v.videoWidth) { ocrStatus('Camera not ready yet.', true); return; }
  const c = $('#cap-canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  await runOcr(c);
}

async function ocrFromFile(file) {
  const img = new Image();
  img.onload = async () => {
    const c = $('#cap-canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    await runOcr(c);
  };
  img.src = URL.createObjectURL(file);
}

/* Read only two regions: top strip (name) and bottom-right (card code). Faster + more accurate. */
async function runOcr(canvas) {
  if (typeof Tesseract === 'undefined') { ocrStatus('OCR engine still loading — try again in a second.', true); return; }
  ocrStatus('Reading card…');
  showLoader('Reading card…');
  const W = canvas.width, H = canvas.height;
  const nameRegion = cropCanvas(canvas, 0, 0, W, Math.round(H * 0.18));            // top strip
  const codeRegion = cropCanvas(canvas, Math.round(W * 0.55), Math.round(H * 0.82), Math.round(W * 0.45), Math.round(H * 0.18)); // bottom-right
  try {
    const [nameRes, codeRes] = await Promise.all([
      Tesseract.recognize(nameRegion, 'eng'),
      Tesseract.recognize(codeRegion, 'eng')
    ]);
    const name = cleanName(nameRes.data.text);
    const code = cleanCode(codeRes.data.text);
    state.scan = { name, code };
    $('#f-name').value = name;
    $('#f-code').value = code;
    $('#scan-result').classList.remove('hidden');
    ocrStatus('Done — check the text below and fix any misreads.');
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
}
// auto-fill the grading fee from the selected service tier
function applyServiceFee() {
  const gr = GRADERS[$('#grader-select').value];
  const idx = parseInt($('#service-select').value) || 0;
  const svc = gr.services[idx];
  if (svc) $('#p-fee').value = svc.fee;
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

/* ---------- eBay price fetch (loader-wrapped, API-ready) ----------
   When your eBay dev key + backend are live, set EBAY_BACKEND to the endpoint and
   flip EBAY_ENABLED = true. The loading screen + flow are already built — no extra work.

   IMPORTANT (honest note): eBay's Browse API gives ACTIVE Buy-It-Now prices with a
   normal dev key. True SOLD/completed prices (to average last-6-months) require eBay's
   Marketplace Insights API, which needs SEPARATE special approval — not guaranteed.
   So the backend should return sold-average IF it has Insights access, else fall back
   to active-listing prices, and tell us which via `source`.
   Backend contract (suggested):
     GET {EBAY_BACKEND}/search?q=<query>&filter=BIN&window=180
     → { source: 'sold'|'active', avg, median, low, count } */
const EBAY_ENABLED = false;               // flip to true when the backend is ready
const EBAY_BACKEND = '';                  // e.g. 'https://your-worker.workers.dev'
async function fetchEbayPrice(query) {
  if (!EBAY_ENABLED || !EBAY_BACKEND) return null; // manual mode until API is wired
  showLoader('Pulling eBay prices…');
  try {
    const r = await fetch(`${EBAY_BACKEND}/search?q=${encodeURIComponent(query)}&filter=BIN&window=180`);
    if (!r.ok) throw new Error('bad response');
    return await r.json(); // { source, avg, median, low, count }
  } catch (e) {
    ocrStatusCalc('Could not reach the eBay price service. Enter prices manually for now.');
    return null;
  } finally {
    hideLoader();
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
      if (d.savedCards) { state.saved = d.savedCards; save(); }
      rankTop();
      alert('Imported learning data. Watchlist and corrections updated.');
    } catch (err) { alert('Could not read that file — make sure it\u2019s a dbz-learning JSON export.'); }
  };
  reader.readAsText(file);
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
  saveWatchlist(w);
  rankTop();
}

/* ---------- events ---------- */
document.body.addEventListener('click', e => {
  const a = e.target.closest('[data-action]'); const t = e.target.closest('[data-view]');
  if (t) { showView(t.dataset.view); return; }
  if (!a) return;
  const map = {
    'start-cam': startCam,
    'capture': captureFromVideo,
    'search-name': () => {
      const nm = $('#s-name').value.trim();
      if (!nm) { alert('Enter a card name to search.'); return; }
      state.scan.name = nm;
      state.scan.code = $('#s-code').value.trim();
      $('#f-name').value = state.scan.name;
      $('#f-code').value = state.scan.code;
      $('#calc-name').textContent = state.scan.name || '—';
      $('#calc-code').textContent = state.scan.code || '';
      buildEbayLinks();
      showView('calc');
    },
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
    'rank-top': rankTop,
    'export-learn': exportCorrections,
    'review-corrections': toggleCorrections
  };
  if (map[a.dataset.action]) map[a.dataset.action]();
});
$('#photo-input').addEventListener('change', e => { if (e.target.files[0]) ocrFromFile(e.target.files[0]); e.target.value = ''; });
$('#import-learn').addEventListener('change', e => { if (e.target.files[0]) importLearning(e.target.files[0]); e.target.value = ''; });
$('#grader-select').addEventListener('change', renderGradeInputs);
$('#service-select').addEventListener('change', applyServiceFee);

renderGradeInputs();
showView('scan');

// cosmetic icon splash on open (~1.3s)
showLoader('Powering up…');
setTimeout(hideLoader, 1300);
