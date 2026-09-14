/* ============================================================================
 * scanner.js — Dragon Ball TCG card scanner (OCR identification only).
 *
 * RESPONSIBILITY: identify a card from an image and return a STRUCTURED result.
 * It does NOT save to inventory, does NOT touch cost basis, quantities, or any
 * financial logic. The result is handed to the app, which shows it for
 * verification before anything is stored.
 *
 * Pipeline:
 *   IMAGE -> PREPROCESS -> OCR (multi-region) -> NORMALIZE -> CARD-NUMBER
 *   EXTRACTION -> DATABASE MATCH (owned cards + pluggable stub) -> VARIANT
 *   ANALYSIS -> CONFIDENCE SCORING -> STRUCTURED RESULT
 *
 * Depends on: Tesseract (global, from CDN). Optionally window.Collection for
 * matching against cards the user already owns. No other app coupling.
 * ==========================================================================*/
const Scanner = (function () {
  'use strict';

  // ---- known Dragon Ball TCG set prefixes (for validating extracted numbers)
  // Not a full card DB — just the SET code shapes, used to sanity-check numbers.
  // Extend freely; unknown prefixes are still accepted but lower confidence.
  const KNOWN_SET_PREFIXES = [
    'BT','EB','SD','FB','FS','P','PB','XD','TB','UW','DB','ST','B','EX','PR'
  ];

  // Rarity tokens that may appear on a card (letters) — used for rarity read.
  // Kept as evidence only; never used to guess a card identity.
  const RARITY_TOKENS = ['C','UC','R','SR','SCR','SEC','L','PR','GR','CR','RRR','SPR'];

  // Variant keywords that may appear in card text / foil callouts.
  const VARIANT_KEYWORDS = [
    { re: /\bALT(?:\.|ERNATE)?\s*ART\b/i, label: 'Alternate Art' },
    { re: /\bSPECIAL\s*ART\b/i,           label: 'Special Art' },
    { re: /\bPARALLEL\b/i,                label: 'Parallel' },
    { re: /\bFOIL\b/i,                    label: 'Foil' },
    { re: /\bSTAR\b/i,                    label: 'Star' },
    { re: /\bPROMO\b/i,                   label: 'Promo' },
    { re: /\bREPRINT\b/i,                 label: 'Reprint' },
    { re: /\bSECRET\b/i,                  label: 'Secret' }
  ];

  /* ---------------- ERROR LEARNING ----------------
   * Remembers the user's past corrections (raw OCR token -> corrected token) so
   * future scans auto-apply them. Stored in localStorage. Purely additive: it can
   * only map a raw string to what the user previously confirmed for that raw string.
   */
  const LEARN_KEY = 'dbz.scan.learn';
  function loadLearn() {
    try { return JSON.parse(localStorage.getItem(LEARN_KEY)) || { number: {}, name: {} }; }
    catch (e) { return { number: {}, name: {} }; }
  }
  function saveLearn(obj) {
    try { localStorage.setItem(LEARN_KEY, JSON.stringify(obj)); } catch (e) {}
  }
  // Record a correction: for the given field, raw OCR -> corrected value the user chose.
  // Only stores when raw and corrected actually differ and both are non-empty.
  function learnCorrection(field, rawVal, correctedVal) {
    const raw = (rawVal || '').trim().toUpperCase();
    const corr = (correctedVal || '').trim();
    if (!raw || !corr || raw === corr.toUpperCase()) return;
    if (field !== 'number' && field !== 'name') return;
    const store = loadLearn();
    store[field][raw] = corr;
    saveLearn(store);
  }
  // Apply a learned correction to a value (exact raw-key match only — never fuzzy,
  // so it can't silently change an identity it wasn't taught).
  function applyLearned(field, rawVal, currentVal) {
    const store = loadLearn();
    const key = (rawVal || '').trim().toUpperCase();
    if (store[field] && store[field][key]) return store[field][key];
    return currentVal;
  }

  /* ---------------- 1. PREPROCESSING ---------------- */
  // Grayscale + light contrast/threshold to help Tesseract. Returns a canvas.
  function preprocess(srcCanvas) {
    try {
      const c = document.createElement('canvas');
      c.width = srcCanvas.width; c.height = srcCanvas.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(srcCanvas, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      // grayscale + contrast stretch
      for (let i = 0; i < d.length; i += 4) {
        let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        // simple contrast around mid
        g = (g - 128) * 1.35 + 128;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i] = d[i + 1] = d[i + 2] = g;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    } catch (e) {
      return srcCanvas; // never fail the scan on preprocessing
    }
  }

  function crop(src, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    c.getContext('2d').drawImage(src, Math.round(x), Math.round(y),
      Math.round(w), Math.round(h), 0, 0, c.width, c.height);
    return c;
  }

  /* ---------------- 2. OCR (multi-region) ---------------- */
  // Reads several regions. Returns { name, number, bottom, full } raw strings.
  async function ocrRegions(canvas) {
    const W = canvas.width, H = canvas.height;
    const pre = preprocess(canvas);
    // Regions (fractions of the card). These are heuristics for DBFW layout.
    const nameC   = crop(pre, 0,          0,          W,        H * 0.16); // top strip = name
    const numberC = crop(pre, W * 0.50,   H * 0.80,   W * 0.50, H * 0.20); // bottom-right = number
    const bottomC = crop(pre, 0,          H * 0.80,   W,        H * 0.20); // whole bottom = set/rarity/small text
    // Number region gets a restricted charset for accuracy.
    const numOpts = { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' };
    const [nameR, numberR, bottomR] = await Promise.all([
      Tesseract.recognize(nameC,   'eng'),
      Tesseract.recognize(numberC, 'eng', numOpts).catch(() => Tesseract.recognize(numberC, 'eng')),
      Tesseract.recognize(bottomC, 'eng')
    ]);
    return {
      name:   (nameR.data.text   || '').trim(),
      number: (numberR.data.text || '').trim(),
      bottom: (bottomR.data.text || '').trim(),
      // confidences from Tesseract (0..100)
      _conf: {
        name:   nameR.data.confidence   || 0,
        number: numberR.data.confidence || 0,
        bottom: bottomR.data.confidence || 0
      }
    };
  }

  /* ---------------- 3. NORMALIZATION ---------------- */
  // Clean a card NAME: keep letters/digits/space/apostrophe/hyphen/&/. — no
  // aggressive character swapping (names must not be silently altered).
  function normalizeName(t) {
    return (t || '')
      .replace(/\n+/g, ' ')
      .replace(/[^A-Za-z0-9 '\-!.&]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  // Fix common OCR digit/letter confusions INSIDE a card number only, where the
  // format is known (letters-prefix, digits-suffix). Never applied to names.
  //  - In the SET-PREFIX part (before the hyphen): digits that should be letters
  //  - In the NUMBER part (after the hyphen): letters that should be digits
  const L2D = { O: '0', I: '1', L: '1', S: '5', B: '8', G: '6', Z: '2', T: '7', A: '4' };
  const D2L = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '6': 'G', '2': 'Z' };

  function fixNumberPart(s) { // after hyphen — should be digits (+ optional trailing letter)
    // keep a trailing letter (e.g. 012a foil), convert the rest to digits
    const m = s.match(/^([A-Z0-9]*?)([A-Z])?$/);
    let core = s, tail = '';
    // detect trailing single letter suffix
    const t = s.match(/^([0-9OISBGZTA]+)([A-Z])$/i);
    if (t) { core = t[1]; tail = t[2]; }
    core = core.replace(/[A-Z]/gi, ch => L2D[ch.toUpperCase()] || ch);
    return core + tail;
  }
  function fixPrefixPart(s) { // before hyphen — leading letters then optional set-number digits
    // e.g. BT31, EB1, FB08. Fix look-alike digits in the LETTER part back to letters.
    const mm = s.match(/^([A-Z0-9]*[A-Z])([0-9]*)$/);
    if (mm) {
      const letters = mm[1].replace(/[0-9]/g, d => D2L[d] || d);
      return letters + mm[2];
    }
    // all-letters or unusual — convert obvious digit-look-alikes to letters
    return s.replace(/[0-9]/g, d => D2L[d] || d);
  }

  // Extract & normalize a card number from arbitrary OCR text.
  // Returns { raw, normalized, valid } — normalized may equal raw.
  function extractCardNumber(text) {
    const up = (text || '').toUpperCase();
    // primary pattern: PREFIX(letters/look-alike-digits) - NUMBER(digits + optional letter)
    // allow OCR look-alikes inside (incl. leading digit that should be a letter); fixed after capture.
    const rx = /([A-Z0-9]{1,4}[A-Z0-9]{0,3})\s*[-–—]\s*([A-Z0-9]{1,4})/g;
    let best = null, m;
    while ((m = rx.exec(up)) !== null) {
      const prefixRaw = m[1], numRaw = m[2];
      const prefix = fixPrefixPart(prefixRaw);
      const num = fixNumberPart(numRaw);
      const normalized = prefix + '-' + num;
      const known = KNOWN_SET_PREFIXES.some(p => prefix.startsWith(p));
      const cand = { raw: (prefixRaw + '-' + numRaw), normalized, known,
                     score: (known ? 2 : 0) + (num.length >= 2 ? 1 : 0) };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) return { raw: best.raw, normalized: best.normalized, valid: best.known };
    // fallback: no hyphen found — try to see a prefix+digits blob
    const blob = up.match(/[A-Z]{1,4}\s*[0-9]{2,4}[A-Z]?/);
    if (blob) {
      const cleaned = blob[0].replace(/\s+/g, '');
      return { raw: blob[0].trim(), normalized: cleaned, valid: false };
    }
    return { raw: '', normalized: '', valid: false };
  }

  // Read a rarity token from the bottom text (evidence only).
  function extractRarity(bottomText) {
    const up = (bottomText || '').toUpperCase();
    // longest tokens first so 'SEC' beats 'C'
    const sorted = RARITY_TOKENS.slice().sort((a, b) => b.length - a.length);
    for (const tok of sorted) {
      const re = new RegExp('(?:^|[^A-Z])' + tok + '(?:[^A-Z]|$)');
      if (re.test(up)) return tok;
    }
    return '';
  }

  // Read a set abbreviation — prefer the prefix of the card number.
  function extractSet(cardNumberNormalized, bottomText) {
    if (cardNumberNormalized && cardNumberNormalized.includes('-')) {
      const pre = cardNumberNormalized.split('-')[0];
      const setNo = pre.match(/^([A-Z]+)/);
      if (setNo) return setNo[1];
    }
    return '';
  }

  /* ---------------- 4. VARIANT ANALYSIS ---------------- */
  // Returns { variant, altArt, confidence, evidence }.
  // If nothing detected, variant stays '' and altArt is 'Unknown — Verify'
  // (never guesses base vs alt).
  function analyzeVariant(allText) {
    const found = [];
    for (const v of VARIANT_KEYWORDS) if (v.re.test(allText)) found.push(v.label);
    if (found.length) {
      const altArt = found.some(f => /Alt|Special|Parallel|Star|Secret/i.test(f)) ? found.join(', ') : '';
      return { variant: found.join(', '), altArt: altArt || '', confidence: 0.7, evidence: found };
    }
    // nothing found → don't guess
    return { variant: '', altArt: 'Unknown — Verify', confidence: 0, evidence: [] };
  }

  /* ---------------- 5. DATABASE MATCH ---------------- */
  // Match against cards the user already OWNS (Collection). Pluggable: an
  // external DB can be injected via Scanner.setExternalMatcher(fn).
  let externalMatcher = null; // async (partial) => [{name,number,set,rarity,variant, score}]
  function setExternalMatcher(fn) { externalMatcher = fn; }

  function ownedCards() {
    try {
      if (window.Collection && window.Collection.allCards) return Object.values(window.Collection.allCards() || {});
    } catch (e) {}
    return [];
  }

  // Score a candidate card against the scan. Card-number is king.
  function scoreCandidate(scan, card) {
    let score = 0; const why = [];
    const scanNum = (scan.number.normalized || '').toUpperCase();
    const cardNum = (card.number || '').toUpperCase();
    if (scanNum && cardNum) {
      if (scanNum === cardNum) { score += 100; why.push('exact number'); }
      else if (scanNum.replace(/[^A-Z0-9]/g,'') === cardNum.replace(/[^A-Z0-9]/g,'')) { score += 80; why.push('normalized number'); }
    }
    const scanName = (scan.name.corrected || '').toLowerCase().trim();
    const cardName = (card.name || '').toLowerCase().trim();
    if (scanName && cardName) {
      if (scanName === cardName) { score += 40; why.push('exact name'); }
      else if (cardName.includes(scanName) || scanName.includes(cardName)) { score += 20; why.push('partial name'); }
    }
    if (scan.set && card.set && scan.set.toUpperCase() === (card.set||'').toUpperCase()) { score += 10; why.push('set'); }
    if (scan.rarity && card.rarity && scan.rarity.toUpperCase() === (card.rarity||'').toUpperCase()) { score += 5; why.push('rarity'); }
    return { card, score, why };
  }

  async function matchCandidates(scan) {
    const pool = ownedCards();
    let cands = pool.map(c => scoreCandidate(scan, c)).filter(c => c.score > 0);
    // external DB (optional, e.g. future JSON/API)
    if (externalMatcher) {
      try {
        const ext = await externalMatcher({
          name: scan.name.corrected, number: scan.number.normalized,
          set: scan.set, rarity: scan.rarity
        });
        (ext || []).forEach(c => cands.push(scoreCandidate(scan, c)));
      } catch (e) { /* external match is best-effort */ }
    }
    cands.sort((a, b) => b.score - a.score);
    // de-dupe by name|number
    const seen = new Set(); const uniq = [];
    for (const c of cands) {
      const k = ((c.card.name||'') + '|' + (c.card.number||'')).toLowerCase();
      if (seen.has(k)) continue; seen.add(k); uniq.push(c);
    }
    return uniq.slice(0, 5); // top 5 possible matches
  }

  /* ---------------- 6. CONFIDENCE SCORING ---------------- */
  function confidenceFor(scan, topMatch) {
    const num = scan.number.normalized
      ? (scan.number.valid ? 0.9 : 0.6) : 0.0;
    const name = scan.name.corrected ? Math.min(0.9, (scan._ocrConf.name || 0) / 100 + 0.1) : 0;
    const set = scan.set ? 0.7 : 0;
    const rarity = scan.rarity ? 0.6 : 0;
    const variant = scan.variant.confidence || 0;
    // overall: exact number match is strongest evidence
    let overall = 0;
    if (topMatch && topMatch.score >= 100) overall = 0.98;
    else if (topMatch && topMatch.score >= 80) overall = 0.85;
    else if (scan.number.valid) overall = 0.7;
    else overall = Math.max(num, name) * 0.6;
    return {
      name: round2(name), number: round2(num), set: round2(set),
      rarity: round2(rarity), variant: round2(variant), overall: round2(overall)
    };
  }
  function round2(x) { return Math.round((x || 0) * 100) / 100; }

  /* ---------------- 7. STRUCTURED RESULT (public entry) ---------------- */
  // scan(canvas) -> Promise<result>. Does NOT save anything.
  async function scan(canvas) {
    if (typeof Tesseract === 'undefined') throw new Error('OCR engine not loaded');
    const t0 = Date.now();
    const raw = await ocrRegions(canvas);

    // --- normalize
    let nameCorrected = normalizeName(raw.name);
    const numFromNumberRegion = extractCardNumber(raw.number);
    const numFromBottom = extractCardNumber(raw.bottom);
    // prefer the dedicated number region; fall back to bottom strip
    let number = numFromNumberRegion.normalized ? numFromNumberRegion : numFromBottom;
    // --- apply learned corrections (exact raw-key match only) ---
    nameCorrected = applyLearned('name', raw.name, nameCorrected);
    const learnedNum = applyLearned('number', number.raw, number.normalized);
    if (learnedNum !== number.normalized) {
      number = { raw: number.raw, normalized: learnedNum, valid: true, learned: true };
    }
    const rarity = extractRarity(raw.bottom);
    const set = extractSet(number.normalized, raw.bottom);
    const allText = [raw.name, raw.bottom].join(' ');
    const variant = analyzeVariant(allText);

    const scanObj = {
      // NAME: raw preserved + corrected
      name:   { raw: raw.name, corrected: nameCorrected },
      // NUMBER: raw preserved + normalized + validity
      number: { raw: number.raw, normalized: number.normalized, valid: number.valid },
      set, rarity, variant,
      _ocrConf: raw._conf,
      _rawOcr: { name: raw.name, number: raw.number, bottom: raw.bottom }
    };

    const candidates = await matchCandidates(scanObj);
    const top = candidates[0] || null;
    const confidence = confidenceFor(scanObj, top);

    return {
      // ---- raw + corrected (never overwrite raw) ----
      rawOcr: scanObj._rawOcr,
      name: scanObj.name.corrected,
      nameRaw: scanObj.name.raw,
      cardNumber: scanObj.number.normalized,
      cardNumberRaw: scanObj.number.raw,
      cardNumberValid: scanObj.number.valid,
      set: scanObj.set,
      rarity: scanObj.rarity,
      variant: scanObj.variant.variant,
      altArt: scanObj.variant.altArt,   // 'Unknown — Verify' when undetectable
      // ---- matching ----
      match: top ? top.card : null,
      matchScore: top ? top.score : 0,
      matchWhy: top ? top.why : [],
      alternativeMatches: candidates.slice(1).map(c => ({ card: c.card, score: c.score })),
      needsVerification: !top || top.score < 100,   // anything less than exact = verify
      // ---- confidence ----
      confidence,
      // ---- meta ----
      image: null,   // filled by caller (keeps scanner decoupled from thumb helper)
      elapsedMs: Date.now() - t0
    };
  }

  return { scan, setExternalMatcher, extractCardNumber, normalizeName, analyzeVariant, preprocess,
           learnCorrection, applyLearned, loadLearn };
})();

if (typeof window !== 'undefined') window.Scanner = Scanner;
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;
