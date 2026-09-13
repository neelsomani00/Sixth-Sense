// =============================================================================
// storage.js
// -----------------------------------------------------------------------------
// Every piece of persistent state the app needs, in one place:
//   1. Recorded sign references   (what the recognition/playback engines use)
//   2. Preset/bundled reference data (so a fresh browser isn't empty on load)
//   3. Vocabulary overrides        (user-added/removed words on top of config.js)
//   4. API settings                (optional Bhashini credentials)
//
// Nothing here talks to a server except the one-time fetch of the bundled
// preset JSON file, which ships inside this same repo — no external network
// call, no tracking, nothing leaves the browser except deliberate,
// user-configured translation/speech API calls made elsewhere in the app.
// =============================================================================

import { STORAGE_KEYS, VOCAB as BASE_VOCAB } from "./config.js";

/* =============================================================================
   1. References (recorded sign templates)
   ============================================================================= */

// A reference store looks like: { WORD: [ {meta, frames}, {meta, frames}, ... ] }
// This guard exists because the on-disk *shape* of that data has changed a
// few times during development (e.g. adding per-part tagging) — rather than
// crash on an old/foreign shape, we detect it and reset cleanly.
function isValidRefStore(refs) {
  for (const word in refs) {
    const takes = refs[word];
    if (!Array.isArray(takes)) return false;
    for (const t of takes) {
      if (!t || typeof t !== "object" || !t.meta || !Array.isArray(t.frames)) return false;
    }
  }
  return true;
}

export function loadReferences() {
  let refs = {};
  try {
    refs = JSON.parse(localStorage.getItem(STORAGE_KEYS.references) || "{}");
  } catch {
    refs = {};
  }
  if (!isValidRefStore(refs)) {
    refs = {};
    localStorage.removeItem(STORAGE_KEYS.references);
    return { references: refs, wasIncompatible: true };
  }
  return { references: refs, wasIncompatible: false };
}

export function saveReferences(refs) {
  localStorage.setItem(STORAGE_KEYS.references, JSON.stringify(refs));
}

/* =============================================================================
   2. Preset/bundled reference data
   -----------------------------------------------------------------------------
   `localStorage` is per-browser: whatever you record only exists on the
   machine you recorded it on. To hand someone (a judge, a teammate on a new
   laptop, a future contributor) a working demo without asking them to
   re-record everything, the trained data needs to ship as an actual file in
   the repo. This function is called once, only when the browser's own
   storage is empty, and loads `data/preset-references.json` as the starting
   dataset. See that file's own comment for how to update it with your real
   recordings before submission/deployment.
   ============================================================================= */

export async function loadPresetReferencesIfEmpty(currentReferences) {
  if (Object.keys(currentReferences).length > 0) return null; // already have local data — never overwrite it
  try {
    const res = await fetch("./data/preset-references.json");
    if (!res.ok) return null;
    const preset = await res.json();
    if (!isValidRefStore(preset) || Object.keys(preset).length === 0) return null;
    return preset;
  } catch {
    return null; // no bundled file, or not served over http(s) — fine, just start empty
  }
}

/* =============================================================================
   3. Vocabulary overrides — let the user add/remove trainable words without
   touching config.js. Stored as a small diff (added/removed) on top of the
   base list in config.js, so config.js stays the single source of truth for
   the DEFAULT vocabulary, and per-browser customization layers on top of it.
   ============================================================================= */

const DEFAULT_VOCAB_OVERRIDES = { added: [], removed: [] };

export function loadVocabOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.vocabOverrides) || "null");
    if (!parsed || !Array.isArray(parsed.added) || !Array.isArray(parsed.removed)) {
      return { ...DEFAULT_VOCAB_OVERRIDES };
    }
    return parsed;
  } catch {
    return { ...DEFAULT_VOCAB_OVERRIDES };
  }
}

export function saveVocabOverrides(overrides) {
  localStorage.setItem(STORAGE_KEYS.vocabOverrides, JSON.stringify(overrides));
}

// Combines config.js's base list with this browser's add/remove overrides
// into the actual list the UI should show. Kept as a pure function (no
// storage access) so it's easy to call repeatedly after any edit.
export function computeEffectiveVocab(overrides) {
  const withoutRemoved = BASE_VOCAB.filter(w => !overrides.removed.includes(w));
  const customAdded = overrides.added.filter(w => !overrides.removed.includes(w) && !withoutRemoved.includes(w));
  return [...withoutRemoved, ...customAdded];
}

/* =============================================================================
   4. API settings (optional — Bhashini credentials, or left blank for the
   free fallbacks: MyMemory for translation, the browser's own voices for
   speech). Nothing here is ever sent anywhere except directly from the
   user's own browser to the chosen API.
   -----------------------------------------------------------------------------
   Background/default keys: if you want the app to work with Bhashini
   out-of-the-box (without every user having to open Settings and paste in
   credentials), copy `js/local-config.example.js` to `js/local-config.js`
   and fill in real values there. That file is listed in `.gitignore` — it
   is never committed, so your keys never end up in a public repo. It only
   supplies a DEFAULT the very first time the app runs in a browser; once a
   user saves their own Settings, that always takes priority.
   ============================================================================= */

const DEFAULT_SETTINGS = {
  bhashiniUserId: "",
  bhashiniApiKey: "",
  preferBhashini: false
};

export async function loadApiSettings() {
  let background = {};
  try {
    // Dynamic import so a missing file fails gracefully instead of breaking
    // the build — this module is optional and gitignored by design.
    const mod = await import("./local-config.js");
    background = mod.default || {};
  } catch {
    background = {}; // no local-config.js present — perfectly normal
  }

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.apiSettings) || "{}");
  } catch {
    saved = {};
  }

  // Priority: explicit user-saved Settings > local background defaults > built-in defaults.
  return { ...DEFAULT_SETTINGS, ...background, ...saved };
}

export function saveApiSettings(settings) {
  localStorage.setItem(STORAGE_KEYS.apiSettings, JSON.stringify(settings));
}
