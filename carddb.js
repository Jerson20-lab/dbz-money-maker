/* ============================================================================
 * carddb.js — Card knowledge base keyed by CARD NUMBER (the primary ID).
 *
 * Two data sources, both optional, merged:
 *   1) SELF-LEARNED (Track A): every number->card the user confirms on the verify
 *      screen is remembered here. Works offline, grows with the collection, covers
 *      BOTH Masters and Fusion World automatically. Stored in localStorage.
 *   2) BUNDLED (Track B, future): a shipped cards.json (normalized from the CGS
 *      datasets). If window.CARD_DB_BUNDLED is present, it's merged in as a base.
 *
 * Exposes lookup(number) exact, and bestMatch(noisyNumber) fuzzy — used by the
 * scanner to correct OCR (e.g. "STO1-O66" -> "ST01-066") and auto-fill name/
 * set/rarity/variant.
 *
 * Does NOT touch inventory, cost basis, or any financial logic.
 * ==========================================================================*/
const CardDB = (function () {
  'use strict';
  const LEARN_KEY = 'dbz.carddb.learned';

  function norm(n){ return (n || '').toUpperCase().replace(/[^A-Z0-9-]/g, ''); }
  // Card-number-aware normalization: in the DIGIT part (after the dash), fix the
  // most common OCR letter->digit confusions (O->0, I/L->1, S->5, B->8, Z->2,
  // G->6). This turns reads like "SB02-OO8" into "SB02-008" as an EXACT match,
  // instead of relying on fuzzy distance (which is ambiguous for such cases).
  function normNum(n){
    let s = norm(n);
    const dash = s.indexOf('-');
    if (dash < 0) return s;
    const head = s.slice(0, dash + 1);
    let tail = s.slice(dash + 1)
      .replace(/O/g,'0').replace(/[IL]/g,'1').replace(/S/g,'5')
      .replace(/B/g,'8').replace(/Z/g,'2').replace(/G/g,'6');
    // keep an optional trailing rarity letter (e.g. 066A) — only convert digits region
    return head + tail;
  }

  function loadLearned(){
    try { return JSON.parse(localStorage.getItem(LEARN_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveLearned(obj){ try { localStorage.setItem(LEARN_KEY, JSON.stringify(obj)); } catch (e) {} }

  // Bundled base (optional). Shape: { "BT16-107": {name,set,rarity,variant}, ... }
  function bundled(){
    try {
      if (typeof window !== 'undefined' && window.CARD_DB_BUNDLED) return window.CARD_DB_BUNDLED;
    } catch (e) {}
    return {};
  }

  // Merged view: learned entries override/extend the bundled base.
  function all(){
    const base = bundled();
    const learned = loadLearned();
    return { ...base, ...learned };
  }

  // Record a confirmed card (from the verify screen). number is the primary key.
  function learn(number, fields){
    const key = norm(number);
    if (!key) return;
    const store = loadLearned();
    store[key] = {
      name: (fields && fields.name) || (store[key] && store[key].name) || '',
      set: (fields && fields.set) || (store[key] && store[key].set) || '',
      rarity: (fields && fields.rarity) || (store[key] && store[key].rarity) || '',
      variant: (fields && fields.variant) || (store[key] && store[key].variant) || ''
    };
    saveLearned(store);
  }

  // Exact lookup by (normalized) number.
  function lookup(number){
    const key = norm(number);
    if (!key) return null;
    const db = all();
    return db[key] ? { number: key, ...db[key] } : null;
  }

  // Small edit distance (Levenshtein) for fuzzy correction.
  function editDistance(a, b){
    a = a || ''; b = b || '';
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = Array.from({length: m+1}, (_,i)=>[i, ...Array(n).fill(0)]);
    for (let j=0;j<=n;j++) dp[0][j]=j;
    for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1]===b[j-1]?0:1));
    return dp[m][n];
  }

  // Fuzzy match a noisy OCR number to the nearest known card number.
  // Returns { card, distance, exact } or null. Only matches within a small distance.
  function bestMatch(noisy){
    const key = norm(noisy);
    if (!key) return null;
    const db = all();
    if (db[key]) return { card: { number: key, ...db[key] }, distance: 0, exact: true };
    // Try digit-normalized form as an EXACT match (fixes O->0, S->5, etc.)
    const nk = normNum(noisy);
    if (nk !== key && db[nk]) return { card: { number: nk, ...db[nk] }, distance: 0, exact: true };
    // Real card numbers look like PREFIX-NNN (e.g. BT11-066). If the noisy read
    // has no digit or is very short, it's almost certainly junk — refuse to
    // match rather than snap garbage like "E-16" onto a real short code.
    if (key.length < 5 || !/[0-9]/.test(key)) return null;
    let best = null, secondDist = Infinity;
    for (const num in db){
      // only compare same-length-ish numbers to keep it cheap + sane
      if (Math.abs(num.length - key.length) > 2) continue;
      const d = editDistance(key, num);
      if (best === null || d < best.distance){ secondDist = best ? best.distance : secondDist; best = { number: num, distance: d }; }
      else if (d < secondDist){ secondDist = d; }
    }
    if (!best) return null;
    // Tolerance scales with length: short codes must match almost exactly, so a
    // 2-edit jump on a tiny code (the "Energy Marker" bug) is rejected.
    const tol = key.length >= 7 ? 2 : 1;
    // Distance 0-1 is trustworthy on its own. At the looser edge (distance 2) we
    // also require it to beat the runner-up, to avoid an arbitrary pick.
    const trustworthy = best.distance <= 1 || (best.distance <= tol && (secondDist - best.distance) >= 1);
    if (trustworthy) {
      return { card: { number: best.number, ...db[best.number] }, distance: best.distance, exact: false };
    }
    return null;
  }

  // Fuzzy-match a noisy OCR'd card NAME against DB names. Used as a fallback
  // when the card-number read fails. Returns the single best match only when
  // it is clearly good (proportional edit-distance threshold) AND unambiguous
  // (comfortably better than the runner-up), so we never guess wildly.
  function nameNorm(s){ return (s||'').toString().toUpperCase().replace(/[^A-Z0-9]/g,''); }
  function matchByName(noisyName){
    const key = nameNorm(noisyName);
    if (key.length < 4) return null;            // too little signal to trust
    const db = all();
    let best = null, secondName = null;         // secondName = best distance among DIFFERENT names
    for (const num in db){
      const nm = nameNorm(db[num].name);
      if (!nm) continue;
      // cheap length pre-filter: names within ~40% length of each other
      if (Math.abs(nm.length - key.length) > Math.max(4, key.length * 0.4)) continue;
      const d = editDistance(key, nm);
      if (best === null || d < best.distance){
        // demote current best to "secondName" only if it is a DIFFERENT name
        if (best && best.norm !== nm && (secondName === null || best.distance < secondName.distance)) {
          secondName = { distance: best.distance };
        }
        best = { number: num, distance: d, len: nm.length, norm: nm };
      } else if (nm !== best.norm && (secondName === null || d < secondName.distance)) {
        secondName = { distance: d };            // a different name, worse or equal
      }
    }
    if (!best) return null;
    // Accept only a strong match: distance within ~25% of the name length, and
    // meaningfully better than the best DIFFERENT-named card (ties among the
    // same card's own variants are fine — we just pick one).
    const tol = Math.max(2, Math.round(best.len * 0.25));
    const clearlyBetter = !secondName || (secondName.distance - best.distance) >= 2 || secondName.distance > tol;
    if (best.distance <= tol && clearlyBetter){
      return { card: { number: best.number, ...db[best.number] }, distance: best.distance, exact: best.distance === 0 };
    }
    return null;
  }

  function count(){ return Object.keys(all()).length; }

  // Official card image URL for a given number (uses img_link == number).
  // Fusion World sets are hosted on Linode; Masters on Google Storage.
  const FW_PREFIXES = ['FB','FS','FP','SB']; // Fusion World set families (+ ST handled below)
  function imageUrl(number){
    // keep underscore for variant filenames (BT16-107_SPR) but drop other junk
    const num = (number||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'');
    if (!num) return '';
    const setCode = num.split('-')[0].replace(/[0-9_].*$/,''); // leading letters
    // ST is used by both games; default ST to Fusion World (its ST01 starter is FW).
    const isFW = FW_PREFIXES.includes(setCode) || setCode === 'ST' || setCode === 'FS' || setCode === 'FP';
    const host = isFW
      ? 'https://dbs-deckplanet.us-southeast-1.linodeobjects.com/deckplanet_card_images/'
      : 'https://storage.googleapis.com/deckplanet_card_images/';
    return host + encodeURIComponent(num) + '.png';
  }

  // All DB printings that share a base number (base + _SPR/_PR/★ variants).
  // e.g. variantsOf("BT16-107") -> [{number:"BT16-107",rarity:"SR",...},{number:"BT16-107_SPR",rarity:"SPR",...}]
  function variantsOf(number){
    const base = norm(number).replace(/_.*$/,'');   // strip any _SPR/_PR suffix to get base
    const db = all();
    const out = [];
    for (const k in db){
      const kb = k.replace(/_.*$/,'');
      if (kb === base) out.push({ number: k, ...db[k] });
    }
    // base first, then variants
    out.sort((a,b)=> a.number.length - b.number.length);
    return out;
  }

  /* ---------------- BUNDLED DB LOADER (Track B) ----------------
   * Fetch the two DeckPlanet card lists FROM THE USER'S DEVICE (which has internet),
   * normalize to {number:{name,set,rarity}}, and persist. After this, the DB works
   * fully offline. Depends on the API allowing CORS from the browser.
   */
  const BUNDLED_KEY = 'dbz.carddb.bundled';
  const SOURCES = [
    'https://api.deckplanet.net/cardsearch/fusion_world_cards?limit=100000',
    'https://api.deckplanet.net/cardsearch/dbs_masters_cards?limit=100000'
  ];
  // Map one raw API card object to our compact shape. Field names per the CGS config:
  // card_number, card_name, card_series, card_rarity.
  function mapRaw(o){
    if (!o) return null;
    const number = (o.card_number || o.number || '').toString().trim().toUpperCase();
    if (!number) return null;
    // rarity often comes as "Super Rare[SR]" — keep the code in brackets if present.
    let rarity = (o.card_rarity || o.rarity || '').toString().trim();
    const m = rarity.match(/\[([^\]]+)\]/); if (m) rarity = m[1];
    return { number, name: (o.card_name || o.name || '').toString().trim(),
             set: (o.card_series || o.set || '').toString().trim(), rarity };
  }
  function loadBundledFromStorage(){
    try {
      const raw = localStorage.getItem(BUNDLED_KEY);
      if (raw) { const obj = JSON.parse(raw);
        // MERGE with any shipped file data (carddb-data.js sets window.CARD_DB_BUNDLED first)
        if (typeof window!=='undefined') window.CARD_DB_BUNDLED = Object.assign({}, window.CARD_DB_BUNDLED||{}, obj);
        return window.CARD_DB_BUNDLED; }
    } catch (e) {}
    return (typeof window!=='undefined' && window.CARD_DB_BUNDLED) || null;
  }
  async function fetchAndLoad(onProgress){
    let merged = {};
    for (const url of SOURCES){
      try {
        if (onProgress) onProgress('Fetching ' + (url.includes('fusion')?'Fusion World':'Masters') + '…');
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const arr = (json && json.data) ? json.data : (Array.isArray(json) ? json : []);
        arr.forEach(o => { const c = mapRaw(o); if (c) merged[c.number] = { name:c.name, set:c.set, rarity:c.rarity }; });
      } catch (e) {
        if (onProgress) onProgress('⚠ Could not load one source (' + e.message + ')');
      }
    }
    const n = Object.keys(merged).length;
    if (n > 0){
      try { localStorage.setItem(BUNDLED_KEY, JSON.stringify(merged)); } catch (e) {}
      if (typeof window!=='undefined') window.CARD_DB_BUNDLED = merged;
    }
    return n;
  }
  // load any previously-fetched bundled DB on startup
  loadBundledFromStorage();

  return { learn, lookup, bestMatch, matchByName, all, count, norm, fetchAndLoad, loadBundledFromStorage, variantsOf, imageUrl };
})();

if (typeof window !== 'undefined') window.CardDB = CardDB;
if (typeof module !== 'undefined' && module.exports) module.exports = CardDB;
