// =============================================================================
// main.js
// -----------------------------------------------------------------------------
// This file's ONLY job is wiring: connecting the DOM (index.html) to the
// engines in the other modules. It intentionally contains no algorithms of
// its own — recognition logic lives in recognition.js, matching/rendering
// logic in playback.js, translation in translate.js, speech in speech.js,
// and all persistence in storage.js. If you're looking for "how does X
// actually work", this is the wrong file; if you're looking for "what
// happens when the user clicks Y", you're in the right place.
// =============================================================================

import { LANGUAGES } from "./config.js";
import {
  loadReferences, saveReferences,
  loadApiSettings, saveApiSettings,
  loadPresetReferencesIfEmpty,
  loadVocabOverrides, saveVocabOverrides, computeEffectiveVocab
} from "./storage.js";
import { createRecognitionEngine } from "./recognition.js";
import { translateText } from "./translate.js";
import { createSpeechRecognizer, isSTTSupported, speak } from "./speech.js";
import { createPlaybackEngine } from "./playback.js";

/* =============================================================================
   STATE
   -----------------------------------------------------------------------------
   `references` and `apiSettings` are mutated in place throughout this file
   (rather than treated as immutable) because several engines below capture
   them by closure (`getReferences: () => references`) — reassigning the
   variable is what lets, say, an Import JSON action be immediately visible
   to the recognition engine without re-creating it.
   ============================================================================= */
let { references, wasIncompatible } = loadReferences();

// apiSettings depends on an optional dynamic import (local-config.js) inside
// loadApiSettings(), so this is a top-level await — supported natively by
// ES modules in every modern browser, and simpler than wrapping the rest of
// this file in an async IIFE just to get one awaited value at the top.
let apiSettings = await loadApiSettings();

// If this browser has never recorded anything, silently try to load the
// bundled preset dataset (data/preset-references.json) shipped in the repo.
// This is what lets a fresh clone/deploy show a working demo immediately,
// instead of starting completely blank. See storage.js for details.
const preset = await loadPresetReferencesIfEmpty(references);
if (preset) {
  references = preset;
  saveReferences(references);
}

// Vocabulary = the base list in config.js, plus/minus this browser's own
// custom additions/removals. Recomputed after every add/remove action.
let vocabOverrides = loadVocabOverrides();
let effectiveVocab = computeEffectiveVocab(vocabOverrides);

/* =============================================================================
   TABS — just show/hide the two top-level panels
   ============================================================================= */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
  });
});

/* =============================================================================
   SETTINGS DRAWER — open/close, plus everything that lives inside it
   ============================================================================= */
const drawer = document.getElementById("settingsDrawer");
const backdrop = document.getElementById("drawerBackdrop");
function openDrawer() { drawer.classList.add("open"); backdrop.classList.add("open"); }
function closeDrawer() { drawer.classList.remove("open"); backdrop.classList.remove("open"); }
document.getElementById("settingsBtn").addEventListener("click", openDrawer);
backdrop.addEventListener("click", closeDrawer);

// --- Bhashini credentials --------------------------------------------------
document.getElementById("bhashiniUserId").value = apiSettings.bhashiniUserId;
document.getElementById("bhashiniApiKey").value = apiSettings.bhashiniApiKey;
document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  apiSettings.bhashiniUserId = document.getElementById("bhashiniUserId").value.trim();
  apiSettings.bhashiniApiKey = document.getElementById("bhashiniApiKey").value.trim();
  saveApiSettings(apiSettings);
  const status = document.getElementById("settingsStatus");
  status.textContent = "Saved";
  status.className = "status-line ok";
  setTimeout(() => { status.textContent = ""; }, 2000);
});

// --- Training data: export / import / clear --------------------------------
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(references)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "sixthsense_references.json"; a.click();
  URL.revokeObjectURL(url);
});
document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  references = JSON.parse(await file.text());
  saveReferences(references);
  refreshRefList();
});
document.getElementById("clearAllBtn").addEventListener("click", () => {
  if (confirm("Delete ALL recorded references? This can't be undone.")) {
    references = {};
    saveReferences(references);
    refreshRefList();
  }
});

/* =============================================================================
   LANGUAGE SELECT (Sign -> Voice tab's "listen translated" target language)
   ============================================================================= */
const targetLangSign = document.getElementById("targetLangSign");
LANGUAGES.forEach(l => {
  const opt = document.createElement("option");
  opt.value = l.code; opt.textContent = l.name;
  if (l.code === "hi") opt.selected = true;
  targetLangSign.appendChild(opt);
});

/* =============================================================================
   VOCABULARY-DRIVEN UI (Settings: Train New Signs)
   -----------------------------------------------------------------------------
   `wordSelect` (which word you're about to record) and `refList` (what's
   already recorded) both need to stay in sync with `effectiveVocab` any
   time it changes — rebuildWordSelect() is the single place that happens.
   ============================================================================= */
const wordSelect = document.getElementById("wordSelect");

function rebuildWordSelect() {
  const previouslySelected = wordSelect.value;
  wordSelect.innerHTML = "";
  effectiveVocab.forEach(w => {
    const opt = document.createElement("option");
    opt.value = w; opt.textContent = w;
    wordSelect.appendChild(opt);
  });
  // keep the same word selected across a rebuild if it still exists
  if (effectiveVocab.includes(previouslySelected)) wordSelect.value = previouslySelected;
}
rebuildWordSelect();

// --- Add a custom word ------------------------------------------------------
document.getElementById("addWordBtn").addEventListener("click", () => {
  const input = document.getElementById("newWordInput");
  const word = input.value.trim().toUpperCase();
  if (!word) return;
  if (effectiveVocab.includes(word)) {
    input.value = "";
    wordSelect.value = word; // just select the existing one
    return;
  }
  vocabOverrides.added.push(word);
  // in case it was previously removed, un-remove it
  vocabOverrides.removed = vocabOverrides.removed.filter(w => w !== word);
  saveVocabOverrides(vocabOverrides);
  effectiveVocab = computeEffectiveVocab(vocabOverrides);
  rebuildWordSelect();
  wordSelect.value = word;
  input.value = "";
});

// --- Remove the currently-selected word -------------------------------------
// Note: this only removes the word from the SELECTABLE list. Any references
// already recorded under that exact word string are left untouched in
// storage — re-adding the same word later makes them reappear, which is a
// deliberate safety net against an accidental removal.
document.getElementById("removeWordBtn").addEventListener("click", () => {
  const word = wordSelect.value;
  if (!word) return;
  const hasRecordings = (references[word] || []).length > 0;
  const msg = hasRecordings
    ? `Remove "${word}" from the list? It has ${references[word].length} recording(s) — they will be KEPT (just hidden) unless you also clear them separately.`
    : `Remove "${word}" from the list?`;
  if (!confirm(msg)) return;
  if (!vocabOverrides.removed.includes(word)) vocabOverrides.removed.push(word);
  vocabOverrides.added = vocabOverrides.added.filter(w => w !== word);
  saveVocabOverrides(vocabOverrides);
  effectiveVocab = computeEffectiveVocab(vocabOverrides);
  rebuildWordSelect();
});

/* =============================================================================
   RECORDED REFERENCE LIST (also in Settings, right below the training controls)
   ============================================================================= */
function tagLabel(meta) {
  if (!meta) return "unknown";
  const parts = [];
  if (meta.right) parts.push("R-hand");
  if (meta.left) parts.push("L-hand");
  if (meta.face) parts.push("Face");
  return parts.join(" + ") || "none";
}

function refreshRefList() {
  const el = document.getElementById("refList");
  el.innerHTML = "";
  const words = effectiveVocab.filter(w => (references[w] || []).length > 0);
  if (words.length === 0) {
    el.innerHTML = '<div class="ref-row"><span class="tag-info">Nothing recorded yet</span></div>';
    return;
  }
  words.forEach(w => {
    const takes = references[w];
    const row = document.createElement("div");
    row.className = "ref-row";

    const left = document.createElement("div");
    left.innerHTML = `<span class="word-name">${w}</span> <span class="tag-info">${tagLabel(takes[takes.length - 1].meta)} · ${takes.length} take(s)</span>`;

    const btnGroup = document.createElement("div");
    btnGroup.className = "btn-group";
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo last";
    undoBtn.addEventListener("click", () => { engine.undoLast(w); });
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.className = "danger";
    clearBtn.addEventListener("click", () => {
      if (confirm(`Delete all takes for "${w}"?`)) engine.clearWord(w);
    });
    btnGroup.append(undoBtn, clearBtn);

    row.append(left, btnGroup);
    el.appendChild(row);
  });
}
refreshRefList();

const camStatus = document.getElementById("camStatus");
if (wasIncompatible) {
  camStatus.textContent = "Old references from a previous version were cleared (format changed) — please re-record";
  camStatus.className = "status-line warn";
}

/* =============================================================================
   RECOGNITION ENGINE (ISL -> English tab)
   ============================================================================= */
const matchToggle = document.getElementById("matchToggle");
const recordBtn = document.getElementById("recordBtn");
const recognizedText = document.getElementById("recognizedText");
const liveSignLabel = document.getElementById("liveSignLabel");

// Tracks the previous frame's match so we only append to recognizedText on
// a genuine CHANGE (a held sign shouldn't spam the same word every frame),
// and so a null (no-match) reset lets the *same* sign be appended again
// after a brief pause — e.g. fingerspelling a double letter like "EE".
let lastRecognizedWord = null;

const engine = createRecognitionEngine({
  videoEl: document.getElementById("video"),
  canvasEl: document.getElementById("overlay"),
  getReferences: () => references,
  onReferencesChange: (refs) => { references = refs; saveReferences(references); refreshRefList(); },
  onStatus: (text, kind) => { camStatus.textContent = text; camStatus.className = "status-line " + (kind || ""); },
  onMatch: (word) => {
    if (word === lastRecognizedWord) return;
    lastRecognizedWord = word;
    if (word) {
      liveSignLabel.textContent = "Currently signing: " + word;
      liveSignLabel.className = "status-line ok";
      recognizedText.value += word + " ";
    } else {
      liveSignLabel.textContent = "Currently signing: —";
      liveSignLabel.className = "status-line";
    }
  }
});

engine.init().then(() => {
  matchToggle.disabled = false;
  recordBtn.disabled = false;
}).catch(err => {
  camStatus.textContent = "Camera setup failed: " + err.message;
  camStatus.className = "status-line warn";
});

// --- Mirror-fix (fallback only — pose-based hand identity is primary; see
// recognition.js for why). Persisted per-device since the correct setting
// depends on the specific camera/driver, not on anything about the app.
const MIRROR_FIX_KEY = "sixthsense_mirror_fix";
const mirrorFixToggle = document.getElementById("mirrorFixToggle");
const storedMirrorFix = localStorage.getItem(MIRROR_FIX_KEY);
mirrorFixToggle.checked = storedMirrorFix === null ? true : storedMirrorFix === "true";
engine.setMirrorFix(mirrorFixToggle.checked);
mirrorFixToggle.addEventListener("change", () => {
  engine.setMirrorFix(mirrorFixToggle.checked);
  localStorage.setItem(MIRROR_FIX_KEY, String(mirrorFixToggle.checked));
});

matchToggle.addEventListener("click", () => {
  if (engine.isMatching) {
    engine.stopMatching();
    matchToggle.textContent = "▶ Start Recognizing";
  } else {
    engine.startMatching();
    matchToggle.textContent = "■ Stop Recognizing";
  }
});

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  const word = wordSelect.value;
  const meta = {
    right: document.getElementById("tagRight").checked,
    left: document.getElementById("tagLeft").checked,
    face: document.getElementById("tagFace").checked
  };
  await engine.recordReference(word, meta);
  refreshRefList();
  recordBtn.disabled = false;
});

// --- Recognized Text box: clear + the two "listen" actions ------------------
document.getElementById("clearRecognizedBtn").addEventListener("click", () => {
  recognizedText.value = "";
});

document.getElementById("listenOgBtn").addEventListener("click", () => {
  speak(recognizedText.value.trim(), "en-IN", "en", apiSettings);
});

document.getElementById("listenTranslatedSignBtn").addEventListener("click", async () => {
  const text = recognizedText.value.trim();
  const status = document.getElementById("translateSignStatus");
  const translatedBox = document.getElementById("translatedTextBox");
  if (!text) { status.textContent = "Nothing to translate yet"; status.className = "status-line warn"; return; }
  const code = targetLangSign.value;
  const lang = LANGUAGES.find(l => l.code === code);
  status.textContent = "Translating…";
  status.className = "status-line";
  try {
    const { text: translated, engine: usedEngine } = await translateText(text, code, apiSettings);
    translatedBox.value = translated;
    status.textContent = `Translated via ${usedEngine}`;
    status.className = "status-line ok";
    await speak(translated, lang.ttsLocale, code, apiSettings);
  } catch (err) {
    status.textContent = "Translation failed: " + err.message;
    status.className = "status-line warn";
  }
});

/* =============================================================================
   ENGLISH -> ISL TAB (speech/typed input, then reverse-translation playback)
   ============================================================================= */
const sentenceInput = document.getElementById("sentenceInput");
const micBtn = document.getElementById("micBtn");
const micStatus = document.getElementById("micStatus");

const recognizer = createSpeechRecognizer(
  (text) => { sentenceInput.value += text; },
  (err) => { micStatus.textContent = "Mic error: " + err; }
);
if (!isSTTSupported()) {
  micBtn.disabled = true;
  micStatus.textContent = "Speech recognition not supported — use Chrome or Edge";
}
micBtn.addEventListener("click", () => {
  if (!recognizer) return;
  if (recognizer.listening) {
    recognizer.stop();
    micBtn.textContent = "🎤 Speak";
    micBtn.classList.remove("rec");
    micStatus.textContent = "Mic idle";
  } else {
    recognizer.start();
    micBtn.textContent = "⏹ Stop";
    micBtn.classList.add("rec");
    micStatus.textContent = "Listening…";
  }
});

// --- Reverse playback --------------------------------------------------------
const playback = createPlaybackEngine({ canvasEl: document.getElementById("playbackStage") });
const wordBreakdown = document.getElementById("wordBreakdown");
const playbackStatus = document.getElementById("playbackStatus");

function tokenize(s) { return s.trim().toUpperCase().split(/\s+/).filter(Boolean); }

function renderBreakdown(tokens) {
  wordBreakdown.innerHTML = "";
  tokens.forEach(t => {
    const found = references[t] && references[t].length > 0;
    const chip = document.createElement("span");
    chip.className = "chip " + (found ? "ok" : "missing");
    chip.textContent = t + (found ? "" : " (untrained)");
    wordBreakdown.appendChild(chip);
  });
}
sentenceInput.addEventListener("input", () => renderBreakdown(tokenize(sentenceInput.value)));

document.getElementById("playBtn").addEventListener("click", async () => {
  const tokens = tokenize(sentenceInput.value);
  renderBreakdown(tokens);
  if (tokens.length === 0) return;
  await playback.playSentence(tokens, references, (word, meta) => {
    const parts = [];
    if (meta.right) parts.push("Right hand");
    if (meta.left) parts.push("Left hand");
    if (meta.face) parts.push("Face");
    playbackStatus.textContent = `${word} — showing ${parts.join(" + ")}`;
  });
  playbackStatus.textContent = "";
});
