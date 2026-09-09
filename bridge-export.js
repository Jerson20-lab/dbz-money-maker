/* DBZ → ProfitTrack export bridge (Phase 2, Part A).
 *
 * Turns inventory events into financial transactions with DETERMINISTIC unique IDs
 * so re-exporting the same data never double-counts. ProfitTrack dedupes on txnId.
 *
 * txnId scheme (stable, derived from source records — NOT random):
 *   dbz:buy:<itemId>       card purchase (expense: acquisition cost)
 *   dbz:grade:<itemId>     grading costs for a card (expense)
 *   dbz:sale:<itemId>      card sale (income: gross sale price)
 *
 * Also emits an inventory SNAPSHOT (cost basis + est value) so ProfitTrack's
 * conservative "Business Value" can include inventory. The snapshot is NOT a
 * transaction — it's a current-state figure, replaced on each import.
 *
 * Category mapping (ProfitTrack side can remap): Inventory / Grading / Sales.
 */
'use strict';

const BridgeExport = (() => {
  const n = v => (v==null||v==='') ? 0 : (+v||0);
  const r2 = x => Math.round((+x||0)*100)/100;

  function cardName(cardKey){
    try { const c = window.Collection.getCard(cardKey); return c ? `${c.name}${c.number?' '+c.number:''}` : cardKey; }
    catch { return cardKey; }
  }
  function gradeLabel(it){ return it.condition==='graded' ? `${it.company||''} ${it.grade||''}`.trim() : 'Raw'; }

  // Build the list of transactions from all inventory items.
  function buildTransactions(){
    const items = (window.Collection && window.Collection.items) ? window.Collection.items() : [];
    const txns = [];
    items.forEach(it => {
      const qty = it.qty || 1;
      const a = it.acq || {};
      const g = it.grading || {};
      const nm = cardName(it.cardKey);
      const gl = gradeLabel(it);
      const acqDate = a.date || it.dateAdded || null;

      // 1) purchase (acquisition cost) — expense. Only if there's a real cost.
      const acqCost = n(a.price) + n(a.shipping) + n(a.tax) + n(a.other);
      if (acqCost > 0) {
        txns.push({
          txnId: `dbz:buy:${it.id}`,
          type: 'expense', category: 'Inventory',
          amount: r2(acqCost * qty),
          date: acqDate,
          description: `Buy: ${nm} (${gl})${qty>1?` x${qty}`:''}`
        });
      }
      // 2) grading costs — expense. Entered as the ACTUAL total spent (not per-unit), so no ×qty.
      const grdCost = n(g.fee) + n(g.shipTo) + n(g.shipBack) + n(g.insurance) + n(g.other);
      if (grdCost > 0) {
        txns.push({
          txnId: `dbz:grade:${it.id}`,
          type: 'expense', category: 'Grading',
          amount: r2(grdCost),
          date: (it.grading && it.grading.date) || acqDate,
          description: `Grading: ${nm} (${gl})`
        });
      }
      // 3) sale — income (gross). ProfitTrack tracks fees via a separate expense line.
      if (it.status === 'sold' && it.sale && it.sale.price != null) {
        const gross = n(it.sale.price);
        txns.push({
          txnId: `dbz:sale:${it.id}`,
          type: 'income', category: 'Sales', moneyType: 'revenue',
          amount: r2(gross * qty),
          date: it.sale.date || null,
          description: `Sold: ${nm} (${gl})${qty>1?` x${qty}`:''}`
        });
        // selling fees as an expense (so net profit is right on the PT side)
        const fees = it.sale.fees != null ? n(it.sale.fees) : (window.Inventory ? window.Inventory.feeOn(gross) : 0);
        if (fees > 0) {
          txns.push({
            txnId: `dbz:fee:${it.id}`,
            type: 'expense', category: 'Selling Fees',
            amount: r2(fees * qty),
            date: it.sale.date || null,
            description: `Selling fees: ${nm} (${gl})`
          });
        }
      }
    });
    return txns;
  }

  // Sealed product purchases -> ONE fixed expense per product (the full purchase cost).
  // The amount never changes as units are opened, so ID-based dedupe stays correct.
  // Opening a product is an internal inventory transfer (sealed -> cards), NOT a new expense,
  // so pulled cards do NOT carry acquisition cost (that would double-count the box).
  function productTransactions(){
    const prods = (window.Products && window.Products.products) ? window.Products.products() : [];
    const txns = [];
    prods.forEach(p => {
      const full = (window.Products.totalCost ? window.Products.totalCost(p.cost) : 0);
      if (full > 0) {
        txns.push({
          txnId: `dbz:product:${p.id}`,
          type: 'expense', category: 'Sealed Product',
          amount: full,                    // FIXED — full purchase cost, never mutates
          date: p.date || null,
          description: `Sealed: ${p.name}${p.set?' ('+p.set+')':''} — ${p.unitsTotal} unit${p.unitsTotal===1?'':'s'} @ ${money2(p.costPerUnit)}`
        });
      }
      // bulk sales from this product are income (recovers box cost)
      (p.bulkSales||[]).forEach(b => {
        if ((+b.amount||0) > 0) {
          txns.push({
            txnId: `dbz:bulk:${b.id}`,
            type: 'income', category: 'Sales', moneyType: 'revenue',
            amount: Math.round((+b.amount||0)*100)/100,
            date: b.date || p.date || null,
            description: `Bulk from ${p.name}${p.set?' ('+p.set+')':''}${b.note?' — '+b.note:''}`
          });
        }
      });
    });
    return txns;
  }
  function money2(x){ return '$'+(Math.round((+x||0)*100)/100).toFixed(2); }

  // Current inventory valuation (conservative = cost basis of UNSOLD items).
  function inventorySnapshot(){
    const items = (window.Collection && window.Collection.items) ? window.Collection.items() : [];
    let costBasis = 0, estValue = 0, unitsHeld = 0, sold = 0;
    items.forEach(it => {
      const qty = it.qty || 1;
      if (it.status === 'sold') { sold += qty; return; }
      if (window.Inventory) {
        costBasis += window.Inventory.costBasisAccounting(it);
        const ev = window.Inventory.estValue(it); if (ev != null) estValue += ev * qty;
      }
      unitsHeld += qty;
    });
    return {
      costBasis: r2(costBasis),        // conservative value of held card inventory
      estValue: r2(estValue),          // optional upside (shown separately)
      unitsHeld, unitsSold: sold,
      sealedValue: sealedProductValue()  // cost of still-sealed product (also conservative)
    };
  }

  // Cost of still-sealed (unopened) product units — part of held inventory value.
  function sealedProductValue(){
    const prods = (window.Products && window.Products.products) ? window.Products.products() : [];
    let v = 0;
    prods.forEach(p => { v += (p.qty||0) * (p.costPerUnit||0); });
    return r2(v);
  }

  // The full export payload.
  function buildPayload(){
    return {
      _dbz: true, kind: 'dbz-profittrack-export', version: 1,
      exportedAt: new Date().toISOString(),
      transactions: [ ...buildTransactions(), ...productTransactions() ],
      inventory: inventorySnapshot()
    };
  }

  function toJSON(){ return JSON.stringify(buildPayload(), null, 2); }

  // ---- Business dashboard metrics (#17) ----
  function dashboard(){
    const items = (window.Collection && window.Collection.items) ? window.Collection.items() : [];
    const prods = (window.Products && window.Products.products) ? window.Products.products() : [];
    let cardBasis=0, cardEst=0, cards=0, atGrading=0, listed=0, soldCount=0;
    let realizedRevenue=0, realizedProfit=0, gradingSpend=0, unrealizedProfit=0;
    items.forEach(it => {
      const qty = it.qty || 1;
      const g = it.grading || {};
      gradingSpend += n(g.fee)+n(g.shipTo)+n(g.shipBack)+n(g.insurance)+n(g.other);
      if (it.status === 'sold' && it.sale) {
        soldCount += qty;
        realizedRevenue += n(it.sale.price) * qty;
        if (window.Inventory) { const p = window.Inventory.profitability(it); if (p.profit!=null) realizedProfit += p.profit * qty; }
      } else {
        cards += qty;
        if (window.Inventory) {
          cardBasis += window.Inventory.costBasisAccounting(it);
          const ev = window.Inventory.estValue(it); if (ev!=null) cardEst += ev*qty;
          const p = window.Inventory.profitability(it); if (p && p.potentialProfit!=null) unrealizedProfit += p.potentialProfit*qty;
        }
        if (it.status === 'at_grading') atGrading += qty;
        if (it.status === 'listed') listed += qty;
      }
    });
    let sealedValue=0, sealedCount=0, productSpend=0, openSpend=0;
    prods.forEach(p => {
      sealedValue += (p.qty||0)*(p.costPerUnit||0);
      sealedCount += (p.qty||0);
      productSpend += (window.Products.totalCost?window.Products.totalCost(p.cost):0);
      openSpend += ((window.Products.openedUnitsFor?window.Products.openedUnitsFor(p):(p.opened||0)))*(p.costPerUnit||0);
    });
    const invested = cardBasis + sealedValue;              // conservative money currently in inventory
    return {
      totalInvBasis: r2(cardBasis + sealedValue),
      cardBasis: r2(cardBasis), cardEst: r2(cardEst),
      sealedValue: r2(sealedValue), sealedCount,
      cards, atGrading, listed, soldCount,
      realizedRevenue: r2(realizedRevenue), realizedProfit: r2(realizedProfit),
      unrealizedProfit: r2(unrealizedProfit),
      gradingSpend: r2(gradingSpend), productSpend: r2(productSpend), openSpend: r2(openSpend),
      roi: cardBasis+sealedValue>0 ? r2(realizedProfit/(realizedProfit+cardBasis+sealedValue)*100) : null
    };
  }

  return { buildTransactions, inventorySnapshot, buildPayload, toJSON, cardName, dashboard };
})();

if (typeof window !== 'undefined') window.BridgeExport = BridgeExport;
if (typeof module !== 'undefined' && module.exports) module.exports = BridgeExport;
