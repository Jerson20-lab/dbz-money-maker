/* DBZ Cloud config — Firebase Realtime Database via plain REST (no SDK).
 *
 * SETUP (free, ~3 min, no credit card):
 *  1. Go to https://console.firebase.google.com → Add project (any name) → skip Analytics.
 *  2. Build → Realtime Database → Create Database → pick a location →
 *     start in "Test mode" (fine for personal use; locks after 30 days —
 *     we set simple rules below to keep it open to just this data).
 *  3. Copy the database URL shown at the top, e.g.
 *       https://dbz-money-xxxx-default-rtdb.firebaseio.com
 *  4. Paste it as CLOUD_URL below (keep the https://, no trailing slash).
 *
 * Data layout in the DB:
 *   /prices/<key>   = { ebay:{raw, PSA:{...}, BGS:{...}, CGC:{...}},
 *                       tcgplayer:{...}, '130point':{...}, when:ISO, source }
 *   /queue/<key>    = { name, code, set, variant, ts }   (phone asks, extension fulfills)
 *
 * key = "<name>|<code>" lowercased (matches the phone app + helper).
 */
const CLOUD_URL = 'https://dbz-money-default-rtdb.firebaseio.com'; // <-- your Firebase DB

const Cloud = {
  configured(){ return /^https:\/\/.+firebaseio\.com/.test(CLOUD_URL); },
  base(){ return CLOUD_URL.replace(/\/$/, ''); },
  keyFor(name, code){ return (String(name||'').trim().toLowerCase()+'|'+String(code||'').trim().toLowerCase()); },
  // sanitize a top-level key for Firebase paths (no . # $ [ ] / | )
  safe(k){ return String(k).replace(/[.#$\[\]\/|]/g,'_'); },

  // Firebase object keys can't contain '.', so grade keys like "9.5" break.
  // Encode grade keys on write (9.5 -> 9_5) and decode on read. Only touches
  // the grade level under a company (ebay.BGS["9.5"] etc.), never the values.
  _encGrades(node){
    if(node==null||typeof node!=='object') return node;
    const out=Array.isArray(node)?[]:{};
    for(const [k,v] of Object.entries(node)){
      const nk = /^[0-9]+(\.[0-9])?$/.test(k) ? k.replace('.','_') : k;
      out[nk] = this._encGrades(v);
    }
    return out;
  },
  _decGrades(node){
    if(node==null||typeof node!=='object') return node;
    const out=Array.isArray(node)?[]:{};
    for(const [k,v] of Object.entries(node)){
      const nk = /^[0-9]+_[0-9]$/.test(k) ? k.replace('_','.') : k;
      out[nk] = this._decGrades(v);
    }
    return out;
  },

  async putPrice(key, data){
    if(!this.configured()) throw new Error('CLOUD_URL not set in cloud.js');
    const url = `${this.base()}/prices/${this.safe(key)}.json`;
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(this._encGrades(data)) });
    if(!r.ok) throw new Error('cloud write failed '+r.status);
    return true;
  },
  async getPrice(key){
    if(!this.configured()) return null;
    const url = `${this.base()}/prices/${this.safe(key)}.json`;
    const r = await fetch(url); if(!r.ok) return null;
    return this._decGrades(await r.json());
  },
  async getQueue(){
    if(!this.configured()) return [];
    const r = await fetch(`${this.base()}/queue.json`); if(!r.ok) return [];
    const obj = await r.json(); if(!obj) return [];
    return Object.entries(obj).map(([k,v])=>({ ...v, _path:k }));
  },
  async enqueue(name, code, extra){
    if(!this.configured()) throw new Error('CLOUD_URL not set in cloud.js');
    const key=this.keyFor(name,code);
    const url=`${this.base()}/queue/${this.safe(key)}.json`;
    await fetch(url,{ method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ key, name, code:code||'', set:(extra&&extra.set)||'', variant:(extra&&extra.variant)||'', ts:Date.now() }) });
    return key;
  },
  async dequeue(path){
    if(!this.configured()) return;
    await fetch(`${this.base()}/queue/${this.safe(path)}.json`, { method:'DELETE' });
  }
};

// Works in both the extension (service worker / popup) and the phone app (window).
if (typeof self !== 'undefined') self.Cloud = Cloud;
if (typeof window !== 'undefined') window.Cloud = Cloud;
if (typeof module !== 'undefined' && module.exports) module.exports = { Cloud, get CLOUD_URL(){ return CLOUD_URL; } };
