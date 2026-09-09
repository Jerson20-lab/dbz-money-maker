/* DBZ Collection & Portfolio module.
 * Handles: card records, collection items (raw/graded, qty, purchase cost),
 * per-card price history, collection value snapshots, events (add/remove/sold),
 * and performance windows (today/7d/30d/3mo/6mo/YTD/1yr/all-time).
 *
 * Accuracy rule (from spec): grading company + grade are ALWAYS kept separate.
 * A collection item stores exact { company:'PSA', grade:'10' } or { raw:true }.
 *
 * All data is local (localStorage). No prices are fabricated — a card's value uses
 * ONLY the matching source/company/grade the user recorded, or shows N/A.
 */
'use strict';

const Collection = (() => {
  const K_CARDS   = 'dbz.col.cards';      // card records (identity)
  const K_ITEMS   = 'dbz.col.items';      // owned items
  const K_PRICES  = 'dbz.col.prices';     // price history per cardKey/source/company/grade
  const K_SNAPS   = 'dbz.col.snapshots';  // collection value over time
  const K_EVENTS  = 'dbz.col.events';     // audit trail
  const K_SETTINGS= 'dbz.col.settings';

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  const today = () => new Date().toISOString().slice(0,10);
  const nowISO = () => new Date().toISOString();

  /* ---------- card records (identity) ---------- */
  function cardKey(c){
    // same physical card -> same key (name|number|set|variant|language)
    return [c.name, c.number, c.set, c.variant, c.language].map(x => String(x||'').trim().toLowerCase()).join('|');
  }
  function upsertCard(c){
    const cards = load(K_CARDS, {});
    const key = cardKey(c);
    cards[key] = { ...(cards[key]||{}), key,
      name:c.name||'', number:c.number||'', set:c.set||'', variant:c.variant||'',
      rarity:c.rarity||'', language:c.language||'EN', image:c.image||cards[key]?.image||'',
      category:c.category||'Dragon Ball TCG' };
    save(K_CARDS, cards);
    return cards[key];
  }
  function getCard(key){ return load(K_CARDS, {})[key] || null; }
  function allCards(){ return load(K_CARDS, {}); }

  // Rename/renumber a card safely: because the key is derived from name|number|set|...,
  // changing them produces a NEW key. We migrate the card record, re-point every owned
  // item, and move price history so nothing loses its link.
  function renameCard(oldKey, fields){
    const cards = load(K_CARDS, {});
    const old = cards[oldKey]; if (!old) return null;
    const merged = { ...old, name: fields.name ?? old.name, number: fields.number ?? old.number,
      set: fields.set ?? old.set, variant: fields.variant ?? old.variant, language: fields.language ?? old.language };
    const newKey = cardKey(merged);
    if (newKey === oldKey) { // identity unchanged (maybe only cosmetic) — just save
      cards[oldKey] = { ...merged, key: oldKey }; save(K_CARDS, cards); return cards[oldKey];
    }
    // move card record
    delete cards[oldKey];
    cards[newKey] = { ...merged, key: newKey };
    save(K_CARDS, cards);
    // re-point items
    const its = items(); let changed = false;
    its.forEach(it => { if (it.cardKey === oldKey) { it.cardKey = newKey; changed = true; } });
    if (changed) save(K_ITEMS, its);
    // migrate price history (priceId starts with cardKey::...)
    const prices = load(K_PRICES, {}); let pChanged = false;
    Object.keys(prices).forEach(pid => {
      if (pid.startsWith(oldKey + '::')) { const np = newKey + pid.slice(oldKey.length); prices[np] = prices[pid]; delete prices[pid]; pChanged = true; }
    });
    if (pChanged) save(K_PRICES, prices);
    return cards[newKey];
  }

  /* ---------- price history ---------- */
  // priceId groups a distinct market: cardKey :: source :: company(or RAW) :: grade(or -)
  function priceId(cardKey, source, company, grade){
    return [cardKey, source, company||'RAW', grade||'-'].join('::');
  }
  // record a price point (never overwrites — appends)
  function recordPrice(cardKey, source, company, grade, price, stats){
    if (price == null || !isFinite(price)) return;
    const all = load(K_PRICES, {});
    const id = priceId(cardKey, source, company, grade);
    (all[id] = all[id] || []).push({ date: today(), t: nowISO(), price: Math.round(price*100)/100, stats: stats||null });
    save(K_PRICES, all);
  }
  function priceHistory(cardKey, source, company, grade){
    return (load(K_PRICES, {})[priceId(cardKey, source, company, grade)]) || [];
  }
  // latest recorded price for a market, or null
  function latestPrice(cardKey, source, company, grade){
    const h = priceHistory(cardKey, source, company, grade);
    return h.length ? h[h.length-1].price : null;
  }

  /* ---------- owned items ---------- */
  // item: { id, cardKey, condition:'raw'|'graded', company, grade, qty, valSource,
  //         purchaseCost, dateAdded }
  function items(){ return load(K_ITEMS, []); }
  function addItem(cardKey, opts){
    const list = items();
    const it = { id: uid(), cardKey, condition: opts.condition||'raw',
      company: opts.condition==='graded' ? (opts.company||'PSA') : null,
      grade: opts.condition==='graded' ? (opts.grade||'10') : null,
      qty: opts.qty||1, valSource: opts.valSource||'ebay',
      purchaseCost: (opts.purchaseCost!=null? +opts.purchaseCost : null),
      dateAdded: today() };
    list.push(it); save(K_ITEMS, list);
    logEvent('CARD_ADDED', { cardKey, itemId: it.id, qty: it.qty, value: itemValue(it) });
    snapshotNow();
    return it;
  }
  function updateItem(id, patch){ const l=items(); const it=l.find(x=>x.id===id); if(it){ Object.assign(it,patch); save(K_ITEMS,l); snapshotNow(); } }
  function removeItem(id, opts){
    const l=items(); const it=l.find(x=>x.id===id); if(!it) return;
    const qtyRemoved = opts?.qty || it.qty;
    logEvent('CARD_'+(opts?.reason==='sold'?'SOLD':'REMOVED'), {
      cardKey: it.cardKey, itemId: it.id, qty: qtyRemoved, reason: opts?.reason||'other',
      salePrice: opts?.salePrice ?? null, value: itemValue(it) });
    if (qtyRemoved >= it.qty) { save(K_ITEMS, l.filter(x=>x.id!==id)); }
    else { it.qty -= qtyRemoved; save(K_ITEMS, l); }
    snapshotNow();
  }

  /* ---------- valuation ---------- */
  // value of one item = matching source/company/grade price × qty. Never mixes.
  function unitValue(it){
    const src = it.valSource || 'ebay';
    if (it.condition === 'graded') {
      return latestPrice(it.cardKey, src, it.company, it.grade);
    }
    return latestPrice(it.cardKey, src, 'RAW', null);
  }
  function itemValue(it){ const u = unitValue(it); return u==null ? null : u * it.qty; }
  function collectionValue(){
    return items().reduce((s,it)=>{ const v=itemValue(it); return s + (v||0); }, 0);
  }
  function totalCards(){ return items().reduce((s,it)=>s+it.qty,0); }

  /* ---------- snapshots (collection value over time) ---------- */
  function snapshots(){ return load(K_SNAPS, []); }
  function snapshotNow(){
    const snaps = snapshots();
    const val = collectionValue();
    const d = today();
    // one snapshot per day — update today's, else append
    const last = snaps[snaps.length-1];
    if (last && last.date === d) { last.value = val; last.t = nowISO(); }
    else snaps.push({ date: d, t: nowISO(), value: val });
    save(K_SNAPS, snaps);
  }
  // value as of a date (most recent snapshot on/before date), or null
  function valueAsOf(dateStr){
    const snaps = snapshots();
    let v = null;
    for (const s of snaps){ if (s.date <= dateStr) v = s.value; else break; }
    return v;
  }
  // performance window: compare current to N days ago (or YTD/all)
  function perf(windowKey){
    const snaps = snapshots();
    if (!snaps.length) return null;
    const cur = snaps[snaps.length-1].value;
    const now = new Date();
    let refDate;
    if (windowKey==='all') { const first=snaps[0]; return diff(cur, first.value); }
    if (windowKey==='ytd') { refDate = `${now.getFullYear()}-01-01`; }
    else {
      const days = {today:1, '7d':7, '30d':30, '3mo':90, '6mo':180, '1yr':365}[windowKey] || 1;
      const d = new Date(now); d.setDate(d.getDate()-days); refDate = d.toISOString().slice(0,10);
    }
    const ref = valueAsOf(refDate);
    if (ref == null) return diff(cur, snaps[0].value); // fall back to earliest
    return diff(cur, ref);
  }
  function diff(cur, prev){ const dollar = cur-prev; const pct = prev!==0 ? (dollar/prev*100) : (cur>0?100:0); return { cur, prev, dollar, pct }; }

  /* ---------- events (audit) ---------- */
  function events(){ return load(K_EVENTS, []); }
  function logEvent(type, data){ const e=events(); e.push({ id:uid(), type, t:nowISO(), date:today(), ...data }); save(K_EVENTS, e); }

  /* ---------- settings ---------- */
  function settings(){ return load(K_SETTINGS, { valuationSource:'ebay' }); }
  function setSettings(s){ save(K_SETTINGS, {...settings(), ...s}); }

  /* ---------- export/import (for developer sync + backup) ---------- */
  function exportAll(){ return { cards:allCards(), items:items(), prices:load(K_PRICES,{}), snapshots:snapshots(), events:events(), settings:settings(), exportedAt:nowISO() }; }
  function importAll(d){ if(d.cards)save(K_CARDS,d.cards); if(d.items)save(K_ITEMS,d.items); if(d.prices)save(K_PRICES,d.prices); if(d.snapshots)save(K_SNAPS,d.snapshots); if(d.events)save(K_EVENTS,d.events); if(d.settings)save(K_SETTINGS,d.settings); }

  return {
    cardKey, upsertCard, getCard, allCards, renameCard,
    recordPrice, priceHistory, latestPrice, priceId,
    items, addItem, updateItem, removeItem,
    unitValue, itemValue, collectionValue, totalCards,
    snapshots, snapshotNow, valueAsOf, perf,
    events, logEvent, settings, setSettings,
    exportAll, importAll, today
  };
})();

if (typeof window !== 'undefined') window.Collection = Collection;
if (typeof module !== 'undefined' && module.exports) module.exports = Collection;
