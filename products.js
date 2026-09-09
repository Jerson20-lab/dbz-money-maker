/* DBZ Sealed Products & Rip Sessions — Phase 3.
 * Tracks sealed TCG product (boxes/packs/blisters/ETBs/cases), multi-unit
 * purchases with per-unit cost allocation, "open product" rip sessions that
 * link a product to the cards pulled from it, and product profitability.
 * ADDITIVE — separate localStorage keys, does not touch collection.js.
 *
 * Data model:
 *  product = { id, name, set, type, qty, opened, unitsTotal, cost:{price,shipping,tax,other},
 *              costPerUnit, date, status, note }
 *      qty      = units still SEALED (not opened)
 *      opened   = units opened so far
 *      unitsTotal = qty + opened (for cost-per-unit)
 *  session = { id, productId, unitLabel, date, cardItemIds:[], note }
 *      links one opened unit to the collection items pulled from it.
 *  Each pulled card is a normal Collection item, tagged sourceProductId + sourceSessionId.
 *  Pulls carry $0 acquisition cost (the box's cost is one product-level expense, counted once).
 *  For per-card break-even display, allocatedCostForItem() spreads the unit cost across its pulls.
 */
'use strict';

const Products = (() => {
  const K_PROD = 'dbz.prod.products';
  const K_SESS = 'dbz.prod.sessions';
  const load = (k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; } };
  const save = (k,v)=> localStorage.setItem(k, JSON.stringify(v));
  const uid = () => 'p'+Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const today = () => new Date().toISOString().slice(0,10);
  const n = v => (v==null||v==='') ? 0 : (+v||0);
  const r2 = x => Math.round((+x||0)*100)/100;

  const TYPES = ['Booster Box','Booster Pack','Blister','ETB','Case','Collection','Other'];

  function products(){ return load(K_PROD, []); }
  function sessions(){ return load(K_SESS, []); }
  function getProduct(id){ return products().find(p=>p.id===id) || null; }
  function getSession(id){ return sessions().find(s=>s.id===id) || null; }

  // total cost of a product purchase
  function totalCost(cost){ return r2(n(cost.price)+n(cost.shipping)+n(cost.tax)+n(cost.other)); }

  /* ---------- buy sealed product (#7,#8) ---------- */
  function addProduct(data){
    const list = products();
    const qty = Math.max(1, parseInt(data.qty,10)||1);
    const cost = { price:n(data.price), shipping:n(data.shipping), tax:n(data.tax), other:n(data.other) };
    const tot = totalCost(cost);
    const p = {
      id: uid(), name: data.name||'Sealed Product', set: data.set||'', type: data.type||'Other',
      qty, opened: 0, unitsTotal: qty, cost, costPerUnit: r2(tot/qty),
      date: data.date||today(), status:'sealed', note: data.note||''
    };
    list.push(p); save(K_PROD, list);
    return p;
  }
  function updateProduct(id, patch){ const l=products(); const p=l.find(x=>x.id===id); if(p){ Object.assign(p,patch);
    if(p.cost){ const t=totalCost(p.cost); p.costPerUnit=r2(t/Math.max(1,p.unitsTotal)); } save(K_PROD,l);} return p; }
  function removeProduct(id){ save(K_PROD, products().filter(p=>p.id!==id)); }

  /* ---------- open a unit -> rip session (#9,#10) ----------
   * Decrements sealed qty, increments opened, creates a session.
   * Returns the session. Cards are added later via addPullToSession.
   */
  function openUnit(productId, unitLabel){
    const l=products(); const p=l.find(x=>x.id===productId);
    if(!p || p.qty<=0) return null;
    p.qty -= 1; p.opened += 1;
    if(p.qty<=0) p.status='opened'; else p.status='partially opened';
    save(K_PROD, l);
    const s = { id: uid(), productId, unitLabel: unitLabel || `${p.name} #${p.opened}`, date: today(), cardItemIds: [], note:'' };
    const ss = sessions(); ss.push(s); save(K_SESS, ss);
    return s;
  }

  // Link an already-created Collection item (a pulled card) to a session (#12 traceability).
  function addPullToSession(sessionId, cardItemId){
    const ss=sessions(); const s=ss.find(x=>x.id===sessionId); if(!s) return;
    if(!s.cardItemIds.includes(cardItemId)) s.cardItemIds.push(cardItemId);
    save(K_SESS, ss);
  }
  function removePullFromSession(sessionId, cardItemId){
    const ss=sessions(); const s=ss.find(x=>x.id===sessionId); if(!s) return;
    s.cardItemIds = s.cardItemIds.filter(id=>id!==cardItemId); save(K_SESS, ss);
  }
  function sessionsForProduct(productId){ return sessions().filter(s=>s.productId===productId); }

  // Allocated cost for ONE pulled card = its unit's per-unit cost ÷ number of pulls in that session.
  // e.g. blister $17.60 with 2 pulls -> each pull allocated $8.80. Box $100 with 12 pulls -> $8.33 each.
  // Returns 0 if the card isn't a pull or its session/product is missing.
  function allocatedCostForItem(cardItemId){
    const s = sessions().find(x => x.cardItemIds.includes(cardItemId));
    if (!s) return 0;
    const p = getProduct(s.productId); if (!p) return 0;
    const pulls = s.cardItemIds.length || 1;
    return r2((p.costPerUnit || 0) / pulls);
  }
  // Which session/product a card came from (traceability helper for UI).
  function sourceOfItem(cardItemId){
    const s = sessions().find(x => x.cardItemIds.includes(cardItemId));
    if (!s) return null;
    const p = getProduct(s.productId);
    return { session:s, product:p };
  }

  /* ---------- product profitability (#11,#19) ----------
   * Needs Collection (for pulled-card values) + Inventory (cost basis, sale info).
   */
  function productProfit(productId){
    const p = getProduct(productId); if(!p) return null;
    const sess = sessionsForProduct(productId);
    const items = (window.Collection && window.Collection.items) ? window.Collection.items() : [];
    const byId = {}; items.forEach(it=>byId[it.id]=it);

    let pulls=0, estValue=0, soldRevenue=0, soldCount=0, remainingValue=0;
    sess.forEach(s => s.cardItemIds.forEach(id => {
      const it = byId[id]; if(!it) return;
      pulls += (it.qty||1);
      if (it.status==='sold' && it.sale) {
        soldRevenue += n(it.sale.price) * (it.qty||1);
        soldCount += (it.qty||1);
      } else {
        const ev = (window.Inventory) ? window.Inventory.estValue(it) : null;
        if (ev!=null) { estValue += ev*(it.qty||1); remainingValue += ev*(it.qty||1); }
      }
    }));

    // cost of the opened portion (allocated): opened units * costPerUnit
    const openedCost = r2(p.opened * p.costPerUnit);
    const totalRecovered = r2(soldRevenue + remainingValue);
    const realizedProfit = r2(soldRevenue - openedCost);          // realized so far vs opened cost
    const projectedProfit = r2(totalRecovered - openedCost);      // if remaining sells at est value
    const roi = openedCost>0 ? r2(projectedProfit/openedCost*100) : null;
    return {
      product:p, openedUnits:p.opened, sealedUnits:p.qty, costPerUnit:p.costPerUnit,
      openedCost, pulls, estPullValue:r2(estValue),
      soldRevenue:r2(soldRevenue), soldCount, remainingValue:r2(remainingValue),
      totalRecovered, realizedProfit, projectedProfit, roi
    };
  }

  // Roll up profitability by SET (#19): all products in a set combined.
  function profitBySet(){
    const bySet = {};
    products().forEach(p => {
      const key = (p.set||'(no set)');
      const pr = productProfit(p.id);
      const b = bySet[key] = bySet[key] || { set:key, boxesOpened:0, spent:0, pullValue:0, sold:0, remaining:0 };
      b.boxesOpened += p.opened;
      b.spent += r2(p.opened*p.costPerUnit);
      if (pr){ b.pullValue += pr.estPullValue + pr.soldRevenue; b.sold += pr.soldRevenue; b.remaining += pr.remainingValue; }
    });
    return Object.values(bySet).map(b => {
      b.spent=r2(b.spent); b.sold=r2(b.sold); b.remaining=r2(b.remaining); b.pullValue=r2(b.pullValue);
      b.projectedProfit = r2((b.sold + b.remaining) - b.spent);
      b.roi = b.spent>0 ? r2(b.projectedProfit/b.spent*100) : null;
      return b;
    });
  }

  return {
    TYPES, products, sessions, getProduct, getSession, totalCost,
    addProduct, updateProduct, removeProduct,
    openUnit, addPullToSession, removePullFromSession, sessionsForProduct,
    allocatedCostForItem, sourceOfItem,
    productProfit, profitBySet, today
  };
})();

if (typeof window !== 'undefined') window.Products = Products;
if (typeof module !== 'undefined' && module.exports) module.exports = Products;
