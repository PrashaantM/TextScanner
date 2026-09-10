// translateHistory.js: remembers what was translated, and lets a phrase be
// saved for later.
//
// The PhotoTranslation surface. Two related but distinct things live here, and
// the distinction is the whole design:
//
//   HISTORY    automatic, capped, and disposable. Every translation is recorded
//              so it can be found again without re-running it. Trimmed to a
//              fixed count so it cannot grow without bound.
//   SAVED      explicit, unbounded, and never auto-removed. A phrase someone
//              starred because they want it again - the "favourites" of a
//              translation app.
//
// Keeping them in one store with a flag rather than two stores is deliberate:
// saving is then a one-field update on a record that already exists, instead of
// a copy that can drift from its original, and the "is this already saved?"
// check is local to the record being displayed.
//
// **A privacy note that shaped the retention policy.** History contains the
// text of things people translated, which is often the most sensitive text the
// app ever sees - a medical letter, a contract, a personal note. So:
//
//   - It is device-local, like everything else here. Nothing is uploaded.
//   - It is capped and trimmed automatically, so it does not silently accumulate
//     years of content.
//   - `clearHistory` genuinely deletes, and Settings offers it plainly.
//   - Saved items are exempt from trimming, because those were an explicit
//     choice; an automatic cap that deletes something a person deliberately
//     starred would be a bug, not a policy.

import { STORES, newId, get, getAll, put, remove } from "./store.js";

// Enough that "I translated that yesterday" is reliably still there, small
// enough that the store stays a few hundred KB at most.
const MAX_HISTORY = 200;

export async function recordTranslation({ sourceText, translatedText, sourceLang, targetLang, tier, docId = null }) {
  const source = (sourceText || "").trim();
  const translated = (translatedText || "").trim();
  if (!source || !translated) return null;

  // Re-translating the same text into the same language should refresh the
  // existing entry rather than stack duplicates - which is what happens when
  // someone re-opens a document and translates it again.
  const existing = (await getAll(STORES.HISTORY)).find(
    (entry) => entry.sourceText === source && entry.targetLang === targetLang
  );

  if (existing) {
    const updated = {
      ...existing,
      translatedText: translated,
      tier: tier || existing.tier,
      sourceLang: sourceLang || existing.sourceLang,
      docId: docId || existing.docId,
      createdAt: Date.now(),
      count: (existing.count || 1) + 1,
    };
    await put(STORES.HISTORY, updated);
    return updated;
  }

  const entry = {
    id: newId("tr"),
    sourceText: source,
    translatedText: translated,
    sourceLang: sourceLang || null,
    targetLang,
    tier: tier || null,
    docId,
    saved: false,
    count: 1,
    createdAt: Date.now(),
  };

  await put(STORES.HISTORY, entry);
  await trimHistory();
  return entry;
}

// Drops the oldest unsaved entries past the cap. Saved entries are counted but
// never removed, so a library of 300 saved phrases is respected rather than
// quietly culled.
export async function trimHistory(max = MAX_HISTORY) {
  const all = await getAll(STORES.HISTORY);
  const unsaved = all.filter((entry) => !entry.saved).sort((a, b) => b.createdAt - a.createdAt);
  if (unsaved.length <= max) return 0;

  const doomed = unsaved.slice(max);
  for (const entry of doomed) await remove(STORES.HISTORY, entry.id);
  return doomed.length;
}

export async function getHistory({ savedOnly = false, search = "", limit = 100 } = {}) {
  const all = await getAll(STORES.HISTORY);
  const needle = search.trim().toLowerCase();

  return all
    .filter((entry) => (savedOnly ? entry.saved : true))
    .filter((entry) => {
      if (!needle) return true;
      return (
        entry.sourceText.toLowerCase().includes(needle) ||
        entry.translatedText.toLowerCase().includes(needle)
      );
    })
    // Saved items float to the top of a combined list, then by recency.
    .sort((a, b) => {
      if (!savedOnly && !!a.saved !== !!b.saved) return a.saved ? -1 : 1;
      return b.createdAt - a.createdAt;
    })
    .slice(0, limit);
}

export async function toggleSaved(id) {
  const entry = await get(STORES.HISTORY, id);
  if (!entry) return null;
  const updated = { ...entry, saved: !entry.saved };
  await put(STORES.HISTORY, updated);
  return updated;
}

export async function removeEntry(id) {
  return remove(STORES.HISTORY, id);
}

// Clears history but keeps saved phrases, which is what "clear history" means
// everywhere else people encounter the phrase. `includeSaved` is the explicit
// escape hatch, and Settings labels it as such.
export async function clearHistory({ includeSaved = false } = {}) {
  const all = await getAll(STORES.HISTORY);
  let removed = 0;
  for (const entry of all) {
    if (!includeSaved && entry.saved) continue;
    await remove(STORES.HISTORY, entry.id);
    removed++;
  }
  return removed;
}

export async function historyStats() {
  const all = await getAll(STORES.HISTORY);
  return {
    total: all.length,
    saved: all.filter((e) => e.saved).length,
    languages: new Set(all.map((e) => e.targetLang)).size,
  };
}
