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

  /* ---------------- CARD DETECTION ----------------
   * Heuristic (no external lib): downscale, find the bounding box of the region
   * that differs from the background (edges/content). Returns {found, box, cropped}.
   * If it can't confidently find a card-shaped region, found=false and we fall back
   * to the whole image (so scanning still works).
   */
  function detectCard(srcCanvas) {
    try {
      const MAXW = 400;
      const scale = Math.min(1, MAXW / srcCanvas.width);
      const w = Math.max(1, Math.round(srcCanvas.width * scale));
      const h = Math.max(1, Math.round(srcCanvas.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(srcCanvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      // background = average of the 4 corners
      const cornerIdx = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
      let br = 0, bg = 0, bb = 0;
      cornerIdx.forEach(i => { br += d[i]; bg += d[i + 1]; bb += d[i + 2]; });
      br /= 4; bg /= 4; bb /= 4;
      const THRESH = 48; // how different from bg counts as "content"
      let minX = w, minY = h, maxX = 0, maxY = 0, hits = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const diff = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
          if (diff > THRESH) {
            hits++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const area = (maxX - minX) * (maxY - minY);
      const frac = area / (w * h);
      const found = hits > (w * h * 0.05) && frac > 0.15 && (maxX > minX) && (maxY > minY);
      if (!found) return { found: false, cropped: srcCanvas };
      // Gently pull an over-wide/over-tall box toward a card shape (0.714),
      // centered on the detected region, so background clutter is excluded.
      const CARD_RATIO = 2.5 / 3.5;
      let bw = maxX - minX, bh = maxY - minY;
      const cx = minX + bw / 2, cy = minY + bh / 2;
      const curRatio = bw / bh;
      if (curRatio > CARD_RATIO * 1.25) bw = bh * CARD_RATIO;
      else if (curRatio < CARD_RATIO * 0.8) bh = bw / CARD_RATIO;
      minX = Math.max(0, cx - bw / 2); maxX = Math.min(w, cx + bw / 2);
      minY = Math.max(0, cy - bh / 2); maxY = Math.min(h, cy + bh / 2);
      // map box back to full-res, with a small padding
      const inv = 1 / scale, pad = 6;
      const x0 = Math.max(0, (minX - pad) * inv);
      const y0 = Math.max(0, (minY - pad) * inv);
      const x1 = Math.min(srcCanvas.width, (maxX + pad) * inv);
      const y1 = Math.min(srcCanvas.height, (maxY + pad) * inv);
      const cw = x1 - x0, ch = y1 - y0;
      if (cw < 40 || ch < 40) return { found: false, cropped: srcCanvas };
      return { found: true, box: { x: x0, y: y0, w: cw, h: ch },
               ratio: +(cw / ch).toFixed(3), fillFrac: +frac.toFixed(2),
               cropped: crop(srcCanvas, x0, y0, cw, ch) };
    } catch (e) {
      return { found: false, cropped: srcCanvas };
    }
  }

  /* ---------------- NUMBER-REGION OCR (multi-variant) ----------------
   * The card number is tiny and the ONLY reliable primary ID. Instead of trusting
   * one pass over the whole card, we crop BOTH bottom corners, upscale, and run
   * several preprocessing variants — then keep the reading that matches a valid
   * card-number grammar. This is what turns a garbled "C778" into "ST01-066".
   */
  // canvas-only preprocessing variants (no external lib):
  function pxGray(src){ // grayscale + contrast stretch
    const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
    const x=c.getContext('2d'); x.drawImage(src,0,0);
    const im=x.getImageData(0,0,c.width,c.height), d=im.data;
    for(let i=0;i<d.length;i+=4){ let g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; g=(g-128)*1.5+128; g=g<0?0:g>255?255:g; d[i]=d[i+1]=d[i+2]=g; }
    x.putImageData(im,0,0); return c;
  }
  function pxThreshold(src, inv){ // Otsu-ish global threshold
    const c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
    const x=c.getContext('2d'); x.drawImage(src,0,0);
    const im=x.getImageData(0,0,c.width,c.height), d=im.data;
    // compute mean luminance as threshold
    let sum=0,n=0; for(let i=0;i<d.length;i+=4){ sum+=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; n++; }
    const t=sum/n;
    for(let i=0;i<d.length;i+=4){ const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; let v=g>t?255:0; if(inv) v=255-v; d[i]=d[i+1]=d[i+2]=v; }
    x.putImageData(im,0,0); return c;
  }
  function upscale(src, factor){
    const c=document.createElement('canvas'); c.width=src.width*factor; c.height=src.height*factor;
    const x=c.getContext('2d'); x.imageSmoothingEnabled=true; x.imageSmoothingQuality='high';
    x.drawImage(src,0,0,c.width,c.height); return c;
  }

  // Given the (detected/cropped) card canvas, read the card number from both corners
  // across multiple preprocessing variants. Returns {raw, normalized, valid} best match.
  async function readNumberFromROIs(card){
    const W=card.width, H=card.height;
    // The card number sits in the lower part of the card, but its exact height
    // varies by layout:
    //   - Fusion World: very bottom corners (y ~0.90-0.99)
    //   - Masters:      a bit higher, above the flavor text (y ~0.74-0.86)
    // So we scan a TALLER band from ~0.72 down, both corners, tight + loose.
    const rois = [
      // very-bottom corners (Fusion World)
      crop(card, W*0.55, H*0.90, W*0.45, H*0.09),
      crop(card, W*0.50, H*0.86, W*0.50, H*0.13),
      crop(card, 0,      H*0.90, W*0.45, H*0.09),
      crop(card, 0,      H*0.86, W*0.50, H*0.13),
      // higher band (Masters — number above flavor text)
      crop(card, W*0.50, H*0.74, W*0.50, H*0.12),
      crop(card, 0,      H*0.74, W*0.50, H*0.12),
      // wide full-width strips catch numbers not hugging a corner
      crop(card, 0,      H*0.72, W,      H*0.10),
      crop(card, 0,      H*0.86, W,      H*0.12)
    ];
    const numOpts = { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-', tessedit_pageseg_mode: '7' };
    const tasks = [];
    for (const roi of rois){
      const up = upscale(roi, 4);
      // 3 variants per ROI: gray, threshold, inverted-threshold
      [pxGray(up), pxThreshold(up,false), pxThreshold(up,true)].forEach(v=>{
        tasks.push(
          Tesseract.recognize(v,'eng',numOpts)
            .catch(()=>({data:{text:'',confidence:0}}))
            .then(r=>({ text:(r.data.text||'').trim(), conf:r.data.confidence||0 }))
        );
      });
    }
    const results = await Promise.all(tasks);
    // score every candidate by grammar validity + confidence
    let best=null;
    for (const r of results){
      const ex = extractCardNumber(r.text);
      if (!ex.normalized) continue;
      const score = (ex.valid?3:0) + (r.conf/100) + (/^[A-Z]{1,4}[0-9]{0,2}-[0-9]{2,3}[A-Z]?$/.test(ex.normalized)?2:0);
      if (!best || score>best.score) best = { ...ex, score, srcConf:r.conf };
    }
    // --- separate RARITY / STAR pass (allow *, letters — no number-only whitelist) ---
    // The rarity code + ★ sits near the number. Read the bottom band WITHOUT the
    // restrictive charset so a star glyph can survive as * / k / x.
    let rarityText = '';
    try {
      const rarOpts = { tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ*' };
      const rBand = upscale(crop(card, W*0.55, H*0.86, W*0.45, H*0.14), 4);
      const rres = await Promise.all([
        Tesseract.recognize(pxGray(rBand),'eng',rarOpts).catch(()=>({data:{text:''}})),
        Tesseract.recognize(pxThreshold(rBand,false),'eng',rarOpts).catch(()=>({data:{text:''}}))
      ]);
      rarityText = rres.map(r=>(r.data.text||'').trim()).join(' ');
    } catch(e){}
    const out = best || { raw:'', normalized:'', valid:false, score:0, srcConf:0 };
    out.rarityText = rarityText;
    return out;
  }

  /* ---------------- 2. OCR ----------------
   * Detect the card, crop to it, then OCR: (a) the full card for names/text, and
   * (b) a high-res bottom band with a restricted charset for the small card number.
   * Returns raw text + per-line data + a detection flag.
   */
  async function ocrRegions(canvas) {
    const det = detectCard(canvas);
    const card = det.cropped;                 // cropped to the card (or full image if not found)
    const W = card.width, H = card.height;
    // Full-card OCR on the ORIGINAL (a hard contrast stretch tends to hurt foil cards).
    // The number comes from the dedicated multi-variant ROI reader below, not this.
    const [fullR, roiNum] = await Promise.all([
      Tesseract.recognize(card, 'eng'),
      readNumberFromROIs(card)
    ]);
    const lines = [];
    try {
      (fullR.data.lines || []).forEach(ln => {
        const t = (ln.text || '').trim();
        if (t) lines.push({ text: t, conf: ln.confidence || 0, yTop: (ln.bbox ? ln.bbox.y0 : 0) / H });
      });
    } catch (e) {}
    return {
      full:   (fullR.data.text || '').trim(),
      roiNum,                                  // {raw, normalized, valid, score, srcConf}
      band:   roiNum.raw || '',                // for rarity/variant hints
      lines,
      detected: det.found,
      detBox: det.box || null,
      detRatio: det.ratio != null ? det.ratio : null,
      detFill: det.fillFrac != null ? det.fillFrac : null,
      _conf: { full: fullR.data.confidence || 0, band: roiNum.srcConf || 0 }
    };
  }

  // Words/phrases that indicate EFFECT/rules text, not a card name. Used to exclude
  // lines when picking the title.
  // Effect/rules text detector. A line is "effect text" if it contains effect-specific
  // keyword phrases (not single words like "Power" that also appear in card names).
  const EFFECT_HINTS = /\b(when this|if your|choose one|choose up to|this card gets|activate\s*:|auto\s*:|on play|counter\s*:|place up to|draw \d|from your (hand|life|deck|warp)|opponent'?s (turn|battle)|super combo|double strike|dual attack|in your (warp|battle area|deck))\b/i;
  // Character trait lines (e.g. "Saiyan/Earthling/Planet Namek", "Saiyan/Wicked Soul").
  const TRAIT_HINTS = /\b(saiyan|earthling|namekian|frieza\s*clan|android|god|majin|wicked soul|planet|universe|resurrection)\b/i;
  const STAT_HINTS = /^\s*[0-9,]{3,}\s*$/; // pure power numbers like 20000, 15000

  /* ---------------- 3. NORMALIZATION ---------------- */
  // From the OCR lines, pick the most likely CARD NAME.
  // Titles are short-ish, near the top, mostly letters, and NOT effect/stat text.
  // Works for both layouts: Fusion World (title at very top) and Masters (title top band).
  function findCardName(lines, fallbackFull) {
    const cand = (lines || [])
      .filter(l => l.text && l.text.length >= 3 && l.text.length <= 48)
      .filter(l => !EFFECT_HINTS.test(l.text))
      .filter(l => !TRAIT_HINTS.test(l.text))
      .filter(l => !STAT_HINTS.test(l.text))
      .filter(l => (l.text.replace(/[^A-Za-z]/g, '').length / l.text.length) > 0.5) // mostly letters
      .map(l => {
        let score = (l.conf || 0);
        if (l.yTop < 0.14) score += 60;          // title band (both layouts put name high OR very bottom)
        else if (l.yTop < 0.30) score += 20;
        else if (l.yTop > 0.88) score += 25;      // Masters name can sit just above traits at bottom
        else score -= 20;                          // middle = almost always effect text
        if (/[:,]/.test(l.text)) score += 8;
        if (/\b(SSJ|SSB|SSG|SSGSS|Super|Saiyan God|Goku|Vegeta|Trunks|Gohan|Broly|Frieza|Cell|Buu|Piccolo|Krillin)\b/i.test(l.text)) score += 12;
        return { text: l.text, score };
      })
      .sort((a, b) => b.score - a.score);
    if (cand.length) return cand[0].text;
    const fl = (fallbackFull || '').split('\n').map(s => s.trim())
      .find(s => s.length >= 3 && !EFFECT_HINTS.test(s) && !TRAIT_HINTS.test(s) && !STAT_HINTS.test(s));
    return fl || '';
  }

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

  function fixNumberPart(s) { // after hyphen — should be digits (+ optional trailing letter variant)
    // A trailing letter is only kept as a variant suffix if it's NOT a digit look-alike
    // (foil suffixes are usually a/b/c/p/f — not O/I/S/B/G/Z). Otherwise convert it.
    const t = s.match(/^([A-Z0-9]+)([A-Z])$/i);
    let core = s, tail = '';
    if (t) {
      const lastLetter = t[2].toUpperCase();
      if (!(lastLetter in L2D)) { core = t[1]; tail = t[2]; }  // real variant suffix, keep
      // else: it's a look-alike (O/I/S/B/G/Z/T/A) → treat as part of the number, convert below
    }
    core = core.replace(/[A-Z]/gi, ch => L2D[ch.toUpperCase()] || ch);
    return core + tail;
  }
  function fixPrefixPart(s) { // before hyphen — SET CODE (letters) + optional set-number (1-2 digits)
    // DBFW prefixes: 1-4 letters then 0-2 digits (BT16, FB05, ST01, EB1, P).
    // Strategy: try each known set code as the leading letters; the remainder (<=2 chars)
    // is the set-number and gets look-alikes converted to digits.
    const up = s.toUpperCase();
    for (const code of KNOWN_SET_PREFIXES.slice().sort((a,b)=>b.length-a.length)) {
      // match code allowing look-alike digits in place of its letters
      const codeRe = new RegExp('^' + code.split('').map(ch => {
        const alt = Object.keys(D2L).filter(d => D2L[d] === ch);
        return alt.length ? '[' + ch + alt.join('') + ']' : ch;
      }).join('') + '([0-9OISBGZ]{0,2})$');
      const m = up.match(codeRe);
      if (m) {
        const setNo = (m[1] || '').replace(/[A-Z]/g, ch => L2D[ch] || ch);
        return code + setNo;
      }
    }
    // unknown code: leading alpha run = code (convert digit look-alikes to letters),
    // trailing 1-2 digit-ish = set number.
    const mm = up.match(/^([A-Z0-9]+?)([0-9OISBGZ]{0,2})$/);
    if (mm) {
      const letters = mm[1].replace(/[0-9]/g, d => D2L[d] || d);
      const digits = (mm[2] || '').replace(/[A-Z]/g, ch => L2D[ch] || ch);
      return letters + digits;
    }
    return up.replace(/[0-9]/g, d => D2L[d] || d);
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
      // Canonical DBFW shape: 2-4 letters, optional set digits, hyphen, then 2-3 digits.
      const canonical = /^[A-Z]{1,2}[A-Z]?[0-9]{1,2}$/.test(prefix) && /^[0-9]{2,3}[A-Z]?$/.test(num);
      const numDigits = /^[0-9]{2,3}[A-Z]?$/.test(num);
      let score = 0;
      if (known) score += 3;
      if (canonical) score += 4;
      if (numDigits) score += 2;           // number part is really digits (not letters like NR)
      if (/[0-9]/.test(prefix)) score += 1; // prefix has a set number (BT16, FB05)
      const cand = { raw: (prefixRaw + '-' + numRaw), normalized, known, score };
      if (!best || cand.score > best.score) best = cand;
    }
    // require a minimally plausible number (avoid matching junk like "ES-NR")
    if (best && best.score >= 2) return { raw: best.raw, normalized: best.normalized, valid: best.known };
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
  /* ---------------- 4. VARIANT ANALYSIS ----------------
   * DBFW alt-arts are signaled by (a) the RARITY CODE (SPR/SCR/SEC are inherently
   * special/alt-art versions) and (b) a STAR marker (★) after the rarity — which OCR
   * usually mangles into *, k, x, or drops. We detect the star, flag it as a star
   * variant, but NEVER guess 1★ vs 2★ (OCR can't count tiny stars) — that goes to Verify.
   * Returns { variant, altArt, starVariant, confidence, evidence }.
   */
  const ALTART_RARITIES = ['SPR', 'SCR', 'SEC']; // inherently special/alt-art rarity codes
  function analyzeVariant(allText, rarity, bandText) {
    const found = [];
    for (const v of VARIANT_KEYWORDS) if (v.re.test(allText)) found.push(v.label);

    // (a) rarity-code signal
    const rar = (rarity || '').toUpperCase();
    const rarityAlt = ALTART_RARITIES.includes(rar);
    if (rarityAlt && !found.includes('Special/Secret Art')) found.push(rar + ' (special/alt art)');

    // (b) star marker. OCR of ★ is unreliable, so we accept either:
    //   - a rarity code immediately followed by a star-like glyph, OR
    //   - a readable rarity code AND a stray star glyph anywhere in the rarity text.
    let starVariant = false;
    const band = (bandText || allText || '').toUpperCase();
    const rarAlt = RARITY_TOKENS.slice().sort((a,b)=>b.length-a.length).join('|');
    const adjacentStar = new RegExp('(?:' + rarAlt + ')\\s*[\\*\\u2605\\u2606KX]', 'i').test(band);
    const hasRarity = new RegExp('(?:^|[^A-Z])(?:' + rarAlt + ')(?:[^A-Z]|$)').test(band);
    const hasStarGlyph = /[\*\u2605\u2606]/.test(band);
    if (adjacentStar || (hasRarity && hasStarGlyph)) starVariant = true;
    if (starVariant && !found.some(f => /star/i.test(f))) found.push('Star (verify 1★/2★)');

    if (found.length) {
      const isAlt = rarityAlt || starVariant || found.some(f => /alt|special|parallel|secret|star/i.test(f));
      return {
        variant: found.join(', '),
        altArt: isAlt ? found.join(', ') : '',
        starVariant,
        confidence: (rarityAlt ? 0.85 : starVariant ? 0.6 : 0.7),
        evidence: found
      };
    }
    // nothing detected → don't guess
    return { variant: '', altArt: 'Unknown — Verify', starVariant: false, confidence: 0, evidence: [] };
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

    // --- pick the name from the OCR lines (excludes effect/stat text) ---
    const nameRawPick = findCardName(raw.lines, raw.full);
    let nameCorrected = normalizeName(nameRawPick);
    // --- find the card number anywhere in the number band, then the full text ---
    // Primary number = multi-variant ROI reader; fall back to full-card text.
    let number = (raw.roiNum && raw.roiNum.normalized) ? raw.roiNum : extractCardNumber(raw.full);
    if (!number.normalized) number = extractCardNumber(raw.band);
    // --- ALSO scan the full OCR text for any card-number-shaped tokens. On some
    // layouts (e.g. Masters) the number prints above the flavor text where the
    // ROI reader may miss it, but it still shows up in the full-card OCR (e.g.
    // "BT11:066"). If one of those tokens is a KNOWN card, prefer it — it's far
    // stronger evidence than a low-confidence ROI read. ---
    let fullTextDbHit = null;
    try {
      if (typeof window !== 'undefined' && window.CardDB) {
        const txt = (raw.full || '').toUpperCase().replace(/[:._]/g, '-');
        const toks = txt.match(/[A-Z]{1,4}[0-9]{0,2}-[0-9]{2,3}[A-Z]?/g) || [];
        for (const tk of toks){
          const hit = window.CardDB.bestMatch(tk);
          if (hit && hit.distance === 0){ fullTextDbHit = hit; break; }      // exact wins
          if (hit && !fullTextDbHit) fullTextDbHit = hit;                     // else keep first close hit
        }
      }
    } catch (e) {}
    // --- apply learned corrections (exact raw-key match only) ---
    nameCorrected = applyLearned('name', nameRawPick, nameCorrected);
    const learnedNum = applyLearned('number', number.raw, number.normalized);
    if (learnedNum !== number.normalized) {
      number = { raw: number.raw, normalized: learnedNum, valid: true, learned: true };
    }
    // --- CardDB: snap a noisy number to a known card number (fuzzy, offline) ---
    // Only trust the number for a DB match if it actually LOOKS like a real card
    // number (PREFIX-NNN: 1-4 letters, dash, 2-3 digits). This stops a garbage
    // read like "B-LY"/"E-16" from snapping onto a real short code (the
    // "Energy Marker" bug). Weak reads fall through to the NAME matcher below.
    const looksLikeCardNumber = /^[A-Z]{1,4}[0-9]{0,2}-[0-9]{2,3}[A-Z]?$/.test(number.normalized || '');
    let dbCard = null;
    try {
      // 1) Strongest: an exact/near card number found anywhere in the full OCR text.
      if (fullTextDbHit) {
        dbCard = fullTextDbHit.card;
        number = { raw: (number && number.raw) || fullTextDbHit.card.number, normalized: fullTextDbHit.card.number,
                   valid: true, dbMatched: true, dbDistance: fullTextDbHit.distance, fromFullText: true };
      }
      // 2) Otherwise, trust the ROI number only if it LOOKS like a real number.
      if (!dbCard && typeof window !== 'undefined' && window.CardDB && number.normalized && looksLikeCardNumber) {
        const m = window.CardDB.bestMatch(number.normalized);
        if (m) {
          dbCard = m.card;
          number = { raw: number.raw, normalized: m.card.number, valid: true, dbMatched: true, dbDistance: m.distance };
        }
      }
      // 3) Last resort: match the OCR'd NAME against the DB.
      if (!dbCard && typeof window !== 'undefined' && window.CardDB && window.CardDB.matchByName) {
        const mn = window.CardDB.matchByName(nameRawPick) || window.CardDB.matchByName(nameCorrected);
        if (mn) {
          dbCard = mn.card;
          number = { raw: number.raw, normalized: mn.card.number, valid: true, dbMatched: true, dbDistance: mn.distance, byName: true };
        }
      }
    } catch (e) {}
    const rarityText = (raw.roiNum && raw.roiNum.rarityText) || '';
    const rarity = (dbCard && dbCard.rarity) || extractRarity(rarityText + ' ' + raw.band + ' ' + raw.full);
    const set = (dbCard && dbCard.set) || extractSet(number.normalized, raw.band);
    const variant = analyzeVariant(raw.full + ' ' + rarityText, rarity, rarityText);
    // If the DB identified the card, its name/variant are authoritative (OCR name is unreliable).
    const finalName = (dbCard && dbCard.name) ? dbCard.name : nameCorrected;
    const finalVariant = (dbCard && dbCard.variant) ? dbCard.variant : variant.variant;

    const scanObj = {
      name:   { raw: nameRawPick, corrected: finalName },
      number: { raw: number.raw, normalized: number.normalized, valid: number.valid },
      set, rarity, variant,
      _ocrConf: { name: raw._conf.full, number: raw._conf.band, bottom: raw._conf.band },
      _rawOcr: { name: nameRawPick, number: number.raw, bottom: raw.band, full: raw.full },
      _detected: raw.detected
    };

    const candidates = await matchCandidates(scanObj);
    const top = candidates[0] || null;
    const confidence = confidenceFor(scanObj, top);
    // DB match is strong evidence — boost overall confidence if we snapped to a known card.
    if (dbCard) confidence.overall = Math.max(confidence.overall, number.dbDistance === 0 ? 0.97 : 0.9);

    return {
      detected: raw.detected,
      dbMatched: !!dbCard,
      dbCard: dbCard || null,
      // ---- raw + corrected (never overwrite raw) ----
      rawOcr: scanObj._rawOcr,
      name: scanObj.name.corrected,
      nameRaw: scanObj.name.raw,
      cardNumber: scanObj.number.normalized,
      cardNumberRaw: scanObj.number.raw,
      cardNumberValid: scanObj.number.valid,
      set: scanObj.set,
      rarity: scanObj.rarity,
      variant: finalVariant,
      altArt: scanObj.variant.altArt,   // 'Unknown — Verify' when undetectable
      starVariant: scanObj.variant.starVariant,
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
      elapsedMs: Date.now() - t0,
      // ---- DIAGNOSTIC: everything we saw, for troubleshooting a bad read ----
      _diag: {
        cardDetected: raw.detected,
        cardBox: raw.detBox ? `${Math.round(raw.detBox.w)}x${Math.round(raw.detBox.h)}` : '',
        cardRatio: raw.detRatio,
        cardFill: raw.detFill,
        fullText: raw.full,
        lines: (raw.lines || []).map(l => ({ text: l.text, conf: Math.round(l.conf), yTop: +(l.yTop||0).toFixed(2) })),
        namePicked: nameRawPick,
        nameCorrected: nameCorrected,
        numberRaw: (raw.roiNum && raw.roiNum.raw) || '',
        numberNormalized: number.normalized || '',
        numberValid: !!number.valid,
        numberScore: (raw.roiNum && raw.roiNum.score) || 0,
        rarityText: (raw.roiNum && raw.roiNum.rarityText) || '',
        dbMatched: !!dbCard,
        dbBy: dbCard ? (number.byName ? 'NAME' : 'NUMBER') : 'none',
        dbCardName: dbCard ? dbCard.name : '',
        dbCardNumber: dbCard ? dbCard.number : '',
        dbDistance: (number.dbDistance != null ? number.dbDistance : ''),
        confidenceOverall: confidence.overall
      }
    };
  }

  return { scan, setExternalMatcher, extractCardNumber, normalizeName, analyzeVariant, preprocess,
           learnCorrection, applyLearned, loadLearn, findCardName, detectCard };
})();

if (typeof window !== 'undefined') window.Scanner = Scanner;
if (typeof module !== 'undefined' && module.exports) module.exports = Scanner;
