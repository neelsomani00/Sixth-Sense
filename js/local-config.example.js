// =============================================================================
// local-config.example.js — TEMPLATE, safe to commit as-is (no real secrets).
// -----------------------------------------------------------------------------
// To make the app work with Bhashini out of the box, WITHOUT every user
// having to open the Settings drawer and paste in credentials themselves:
//
//   1. Copy this file to `local-config.js` (same folder).
//   2. Fill in your real Bhashini User ID / API Key below.
//   3. Never commit `local-config.js` — it's already listed in .gitignore
//      for exactly this reason. Keep secrets out of a public repo.
//
// If `local-config.js` doesn't exist, the app just uses the free defaults
// (MyMemory for translation, the browser's own voices for speech) — nothing
// breaks, nothing is required. This file only provides a DEFAULT for a
// browser that hasn't saved its own Settings yet; a user's own saved
// Settings always take priority over whatever is here.
// =============================================================================

export default {
  bhashiniUserId: "",
  bhashiniApiKey: ""
};
