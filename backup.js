/* DBZ Backup & Restore.
 * Protects ALL app data (every dbz.* localStorage key) against iOS storage
 * eviction and accidents.
 *
 * - Auto-backup every 3 days -> a rolling snapshot kept in localStorage (survives
 *   app code updates; the SW never touches localStorage).
 * - Auto-restore ONLY when data is missing: if core data (inventory items) is empty
 *   but a backup exists, restore from it. This NEVER overwrites existing data, so it
 *   can't wipe recent work.
 * - Manual: backupNow(), downloadBackup(), restoreFromText(json).
 *
 * The rolling snapshot is stored under 'dbz.backup.latest' with a timestamp under
 * 'dbz.backup.when'. Download produces a file the user keeps off-device.
 */
'use strict';

const Backup = (() => {
  const PREFIX = 'dbz.';
  const K_LATEST = 'dbz.backup.latest';   // note: excluded from its own snapshot
  const K_WHEN   = 'dbz.backup.when';
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

  // Collect every dbz.* key EXCEPT the backup's own storage (avoid nesting).
  function collect(){
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      if (k === K_LATEST || k === K_WHEN) continue;
      data[k] = localStorage.getItem(k);
    }
    return data;
  }

  function payload(){
    return { _dbzBackup: true, version: 1, when: new Date().toISOString(), data: collect() };
  }

  // Save a rolling snapshot into localStorage.
  function backupNow(){
    try {
      localStorage.setItem(K_LATEST, JSON.stringify(payload()));
      localStorage.setItem(K_WHEN, new Date().toISOString());
      return true;
    } catch (e) { return false; }
  }

  function lastBackupWhen(){ return localStorage.getItem(K_WHEN) || null; }
  function hasBackup(){ const raw = localStorage.getItem(K_LATEST); return !!raw; }

  // Apply a backup payload (restore). Writes each saved key back.
  function apply(p){
    if (!p || !p.data) return false;
    Object.keys(p.data).forEach(k => { try { localStorage.setItem(k, p.data[k]); } catch(e){} });
    return true;
  }

  // Restore from the rolling snapshot.
  function restoreLatest(){
    try { const raw = localStorage.getItem(K_LATEST); if (!raw) return false; return apply(JSON.parse(raw)); }
    catch (e) { return false; }
  }

  // Restore from a pasted/imported JSON string (manual, or a downloaded file).
  function restoreFromText(text){
    try {
      const p = JSON.parse(text);
      if (!p || !p._dbzBackup || !p.data) return { ok:false, error:'Not a DBZ backup file.' };
      apply(p);
      return { ok:true, when:p.when };
    } catch (e) { return { ok:false, error:'Could not read that backup.' }; }
  }

  // Download the current data as a file the user keeps.
  function downloadBackup(){
    const blob = new Blob([JSON.stringify(payload(), null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dbz-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  // Is core data present? (used to decide auto-restore). We check inventory items.
  function dataPresent(){
    try {
      const items = JSON.parse(localStorage.getItem('dbz.col.items') || '[]');
      const prods = JSON.parse(localStorage.getItem('dbz.prod.products') || '[]');
      return (Array.isArray(items) && items.length > 0) || (Array.isArray(prods) && prods.length > 0);
    } catch (e) { return false; }
  }

  // Run on app start:
  //  1) If data is MISSING but a backup exists -> auto-restore (safe: nothing to lose).
  //  2) Else if it's been >= 3 days since last backup (or never) -> auto-backup.
  function tick(){
    let restored = false;
    if (!dataPresent() && hasBackup()) {
      restored = restoreLatest();
    }
    const when = lastBackupWhen();
    const due = !when || (Date.now() - new Date(when).getTime()) >= THREE_DAYS;
    // Only auto-backup when there's actually data to back up.
    if (due && dataPresent()) backupNow();
    return { restored };
  }

  return { backupNow, lastBackupWhen, hasBackup, restoreLatest, restoreFromText, downloadBackup, dataPresent, tick, payload };
})();

if (typeof window !== 'undefined') window.Backup = Backup;
if (typeof module !== 'undefined' && module.exports) module.exports = Backup;
