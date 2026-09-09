/* DBZ Inventory — Phase 1 (business layer).
 * Extends the existing Collection module with a full TCG-business inventory:
 * complete cost basis, statuses, sale tracking, minimum-sell prices, and
 * per-card profitability. ADDITIVE ONLY — existing Collection items keep working.
 *
 * A card "item" (from collection.js addItem) is enriched with optional business
 * fields. All new fields are optional so pre-existing items are unaffected:
 *   status         : 'in_inventory'|'listed'|'sold'|'at_grading'|'graded'|'damaged'|'lost'
 *   acq: { price, shipping, tax, other, date }   // acquisition costs
 *   grading: { fee, shipTo, shipBack, insurance, other }   // added over the grading workflow (Phase 4)
 *   listPrice      : number|null
 *   sale: { price, fees, date }                  // when sold
 *   sourceProductId, sourceSessionId             // set by rip sessions (Phase 3)
 *
 * Fee model: platform selling fees. Default eBay-ish 13.25% + $0.30, editable.
 */
'use strict';

const Inventory = (() => {
  const K_SET = 'dbz.inv.settings';
  const load = (k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; } };
  const save = (k,v)=> localStorage.setItem(k, JSON.stringify(v));

  const STATUSES = [
    { key:'in_inventory', label:'In Inventory' },
    { key:'listed',       label:'Listed' },
    { key:'at_grading',   label:'At Grading' },
    { key:'graded',       label:'Graded' },
    { key:'sold',         label:'Sold' },
    { key:'damaged',      label:'Damaged/Lost' }
  ];
  const MARGINS = [0, 5, 10, 20, 25, 30]; // 0 = break-even

  function settings(){ return load(K_SET, { feePct: 13.25, feeFlat: 0.30 }); }
  function setSettings(s){ save(K_SET, { ...settings(), ...s }); }

  const n = v => (v==null||v==='') ? 0 : (+v||0);

  /* ---------- cost basis (#4) ---------- */
  // Total cost basis = purchase + shipping + tax + other acquisition + all grading costs.
  function costBasis(item){
    if (!item) return 0;
    const a = item.acq || {};
    const g = item.grading || {};
    const grd = n(g.fee) + n(g.shipTo) + n(g.shipBack) + n(g.insurance) + n(g.other);
    // If this card was pulled from a sealed product, its cost is the allocated box/blister share ONLY.
    // Any stored acq.price on a pull is stale (older versions seeded it) and would double-count the box cost.
    const alloc = (item.id && window.Products && window.Products.allocatedCostForItem) ? window.Products.allocatedCostForItem(item.id) : 0;
    const isPull = !!(item.sourceSessionId) || (window.Products && window.Products.sourceOfItem && window.Products.sourceOfItem(item.id));
    const acq = isPull ? 0 : (n(a.price) + n(a.shipping) + n(a.tax) + n(a.other));
    return round2(acq + grd + alloc);
  }
  // Total basis across all copies: acquisition is per-unit (×qty), grading + allocated pull cost per-item (×1).
  function costBasisTotal(item){
    if (!item) return 0;
    const a = item.acq || {};
    const g = item.grading || {};
    const qty = item.qty || 1;
    const grd = n(g.fee) + n(g.shipTo) + n(g.shipBack) + n(g.insurance) + n(g.other);
    const alloc = (item.id && window.Products && window.Products.allocatedCostForItem) ? window.Products.allocatedCostForItem(item.id) : 0;
    const isPull = !!(item.sourceSessionId) || (window.Products && window.Products.sourceOfItem && window.Products.sourceOfItem(item.id));
    const acq = isPull ? 0 : (n(a.price) + n(a.shipping) + n(a.tax) + n(a.other)) * qty;
    return round2(acq + grd + alloc);
  }
  // ACCOUNTING basis (for P&L/snapshot): acquisition×qty + grading. EXCLUDES allocated pull cost,
  // because a pulled card's box cost is already counted as the sealed-product expense — including it
  // here would double-count. Use costBasis/costBasisTotal (with allocation) for per-card break-even display.
  function costBasisAccounting(item){
    if (!item) return 0;
    const a = item.acq || {};
    const g = item.grading || {};
    const qty = item.qty || 1;
    const acq = (n(a.price) + n(a.shipping) + n(a.tax) + n(a.other)) * qty;
    const grd = n(g.fee) + n(g.shipTo) + n(g.shipBack) + n(g.insurance) + n(g.other);
    return round2(acq + grd);
  }

  /* ---------- selling fees ---------- */
  // Fee charged by the platform on a given sale price.
  function feeOn(salePrice){
    const s = settings();
    return round2(n(salePrice) * (s.feePct/100) + s.feeFlat);
  }
  // Net revenue after fees.
  function netRevenue(salePrice){ return round2(n(salePrice) - feeOn(salePrice)); }

  /* ---------- minimum sell prices (#5) ----------
   * Solve for salePrice S such that: net(S) = basis * (1 + margin).
   * net(S) = S*(1-f) - flat.  =>  S = (target + flat) / (1 - f).
   * target = basis*(1+margin/100). margin 0 => break-even.
   */
  function minSellForMargin(item, marginPct){
    const s = settings();
    const f = s.feePct/100, flat = s.feeFlat;
    const basis = costBasis(item);
    const target = basis * (1 + marginPct/100);
    if (f >= 1) return null; // guard
    return round2((target + flat) / (1 - f));
  }
  // Full table of break-even + each margin (#5).
  function minSellTable(item){
    return MARGINS.map(m => ({ marginPct:m, label: m===0?'Break-even':`${m}% profit`, price: minSellForMargin(item, m) }));
  }
  function breakEven(item){ return minSellForMargin(item, 0); }

  /* ---------- profitability (#18) ---------- */
  // Uses Collection's latest matching market price for "current estimated value".
  function estValue(item){
    try { return (window.Collection && window.Collection.unitValue) ? window.Collection.unitValue(item) : null; }
    catch { return null; }
  }
  // Potential (if sold at target/estimated) — realized when a real sale is recorded.
  function profitability(item){
    const basis = costBasis(item);
    const est = estValue(item);
    const be = breakEven(item);
    const sold = item.status === 'sold' && item.sale && item.sale.price != null;
    if (sold) {
      const gross = n(item.sale.price);
      const fees = item.sale.fees != null ? n(item.sale.fees) : feeOn(gross);
      const net = round2(gross - fees);
      const profit = round2(net - basis);
      return { realized:true, basis, salePrice:gross, fees, net, profit, roi: basis>0 ? round2(profit/basis*100) : null };
    }
    // unrealized: base on current estimated value (or listing price if set)
    const ref = item.listPrice!=null ? n(item.listPrice) : (est!=null ? n(est) : null);
    if (ref == null) return { realized:false, basis, breakEven:be, estValue:est, potentialProfit:null, potentialRoi:null };
    const net = netRevenue(ref);
    const profit = round2(net - basis);
    return { realized:false, basis, breakEven:be, estValue:est, ref, net, potentialProfit:profit, potentialRoi: basis>0 ? round2(profit/basis*100) : null };
  }

  /* ---------- status helpers (#3) ---------- */
  function setStatus(item, status){ item.status = status; }
  function statusLabel(key){ const s=STATUSES.find(x=>x.key===key); return s?s.label:(key||'In Inventory'); }

  /* ---------- grading workflow (#6) ----------
   * These build the PATCH to pass to Collection.updateItem — this module stays
   * storage-agnostic. sendToGrading sets status 'at_grading' + submission info +
   * seeds grading costs. completeGrading sets the final grade + returns date +
   * any extra costs, and flips the card to 'graded' (its cost basis now includes
   * grading, used everywhere).
   */
  function sendToGradingPatch(opts){
    return {
      status: 'at_grading',
      condition: 'graded',
      company: opts.company || 'PSA',
      grading: {
        fee: n(opts.fee), shipTo: n(opts.shipTo), shipBack: n(opts.shipBack),
        insurance: n(opts.insurance), other: n(opts.other),
        submissionNo: opts.submissionNo || '',
        submittedDate: opts.submittedDate || null,
        date: opts.submittedDate || null   // used as the grading expense date on export
      }
    };
  }
  function completeGradingPatch(existingItem, opts){
    const g = { ...(existingItem.grading||{}) };
    // add any extra costs entered on return
    if (opts.extraShip!=null) g.shipBack = n(g.shipBack) + n(opts.extraShip);
    if (opts.extraOther!=null) g.other = n(g.other) + n(opts.extraOther);
    g.returnedDate = opts.returnedDate || today();
    return {
      status: 'graded',
      condition: 'graded',
      company: opts.company || existingItem.company || 'PSA',
      grade: opts.grade != null ? String(opts.grade) : existingItem.grade,
      grading: g
    };
  }

  const today = () => new Date().toISOString().slice(0,10);

  function round2(x){ return Math.round((+x||0)*100)/100; }

  return {
    STATUSES, MARGINS,
    settings, setSettings,
    costBasis, feeOn, netRevenue,
    costBasisTotal, costBasisAccounting,
    minSellForMargin, minSellTable, breakEven,
    estValue, profitability,
    setStatus, statusLabel, round2,
    sendToGradingPatch, completeGradingPatch
  };
})();

if (typeof window !== 'undefined') window.Inventory = Inventory;
if (typeof module !== 'undefined' && module.exports) module.exports = Inventory;
