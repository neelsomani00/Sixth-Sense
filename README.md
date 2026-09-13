# Sixth-Sense — A Two-Way ISL Translator

**Sixth-Sense** is a two-way translator between Indian Sign Language
and spoken/written language, built for a hackathon MVP. It runs entirely in
the browser — no backend server, no account, no login.

- **Sign → Voice**: point a webcam at a signer, Sixth-Sense recognizes the
  sign from a trained vocabulary and builds it up in an editable text box,
  with buttons to hear it spoken in English or a translated language.
- **Voice → Sign**: speak or type a sentence, Sixth-Sense plays back an
  animated skeleton performing each trained sign in sequence.

The interface is deliberately just two tabs plus a Settings drawer — training
new signs, API credentials, and data export/import all live in Settings so
the day-to-day two tabs stay uncluttered.

### Why plain HTML/CSS/JS, no framework, no backend

- **Lightweight and fast on slow connections** — no framework bundle to
  download, no build step, just small source files.
- **Fully client-side, which is also what makes it scalable** — there is no
  application server to provision or pay for; a static file host serves 10
  users exactly as cheaply as 10,000.
- **Privacy by construction, not by policy** — video never leaves the
  device because there's no backend it could be sent to. Recorded sign data
  stays in the browser's own storage unless you deliberately export it.
- **Responsive** — usable from a phone-sized screen up through desktop.
- **Discoverable** — proper SEO metadata and Open Graph/Twitter card tags,
  so a shared link renders an actual preview instead of a bare URL.

See `WORK.md` for the full technical reasoning behind each of these.

---

## How it actually works (read this before demoing)

This is **not** a trained neural network. Building and training a deep
learning model for sign recognition is a real research undertaking — not
something achievable correctly in a hackathon timeframe. Instead, Sixth-Sense uses
**deterministic template matching**, which is honest about what it is and
works well for a fixed, closed vocabulary:

1. **Capture**: [MediaPipe Holistic Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/holistic_landmarker)
   tracks pose, both hands, and face — 543 points — directly in the browser.
2. **Per-part tagging**: every recorded sign is tagged with which body parts
   actually matter for it (right hand / left hand / face). Untagged parts are
   completely excluded from matching — so, for example, a hand-only sign's
   match score is never affected by whatever your face happens to be doing.
3. **Normalization**: each hand is normalized against its own wrist and palm
   size (not the shoulders), so recognition still works even when the camera
   is framed tightly on just the hands.
4. **Matching**: recognizing a live sign means comparing a short rolling
   window of your live landmarks against every recorded reference using
   [Dynamic Time Warping](https://en.wikipedia.org/wiki/Dynamic_time_warping)
   (handles signs performed at slightly different speeds), and reporting the
   closest match — or nothing, if nothing is close enough.
5. **Reverse direction**: the exact same recorded landmark data doubles as
   the "what does this sign look like" data for playback — no separate video
   recording step needed. Hands are drawn as connected skeletons (not loose
   dots) for human readability, and only the tagged parts for that sign are
   shown.

**What this means in practice**: recognition quality depends entirely on how
much and how varied your training data is. Record 2–3 takes per word, from
more than one signer, for anything close to reliable generalization. This is
a deliberate, honest trade-off for a 1-day build — not a shortcut hidden from
you.

### Hand identity (left vs. right)

MediaPipe's own left/right hand classification can be unreliable on its own —
it can flicker, especially as hands move near the body's center. Instead of
trusting that classifier, Sixth-Sense assigns hand identity by **physical
proximity to the pose skeleton's own wrist points**: whichever detected hand
is spatially closer to the pose's left wrist genuinely *is* the left hand,
regardless of what MediaPipe itself labeled it. This only requires your
shoulders to be visible to the camera.

If the camera is framed so tight that shoulders aren't visible, there's
nothing to anchor against — in that fallback case only, a manual "Mirror fix"
toggle (under the camera preview) lets you calibrate per-device, since
whether a camera's raw feed is already mirrored varies by laptop/driver.

---

## Translation & speech

- **Speech-to-text**: the browser's built-in Web Speech API. Free, no setup,
  works in Chrome/Edge.
- **Translation — a 3-layer fallback chain**, each tier existing for a
  specific reason, falling through automatically so a failure in one never
  breaks the app:
  1. **Bhashini** (if you've added credentials in Settings) — Government of
     India's platform, purpose-built for all 22 official Indian languages,
     so it's the best choice specifically for those languages when configured.
  2. **Chrome's built-in on-device Translator API** (Chrome 138+, desktop
     only) — free, no API key, nothing leaves the device, and meaningfully
     better quality than the last-resort option below. Not available in
     Edge/Firefox/Safari or on mobile, so it's a bonus tier, not a dependency.
  3. **MyMemory** — free, works in any browser, no setup — but a
     crowd-sourced "translation memory" rather than a real MT engine, so
     quality is noticeably weaker. This is what guarantees the app always
     produces *some* result, everywhere, with zero configuration.
- **Text-to-speech**: the browser's installed voices by default (varies by
  device/OS — this is a genuine platform limitation, not something the app
  controls). Bhashini TTS, when configured, returns real generated audio for
  any of its supported languages regardless of what's installed locally.

### Setting up Bhashini (optional)

1. Register at <https://bhashini.gov.in/ulca/user/register> and verify your
   email.
2. Log in, go to **My Profile**, and generate an API Key.
3. Copy your **User ID** and **API Key** into Sixth-Sense's Settings drawer (gear
   icon, top right) and hit Save.

Nothing is hardcoded or committed to this repo — credentials live only in
your own browser's local storage and are sent directly from your browser to
Bhashini's API.

---

## Project structure

```
sixth-sense/
├── index.html          # App shell: header, tabs, both panels, settings drawer
├── favicon.svg          # Third-eye brand mark, used as favicon
├── .gitignore            # Keeps real API secrets (local-config.js) out of version control
├── css/
│   └── style.css         # Design system (see below) + all component styles + responsive rules
├── js/
│   ├── config.js          # Vocabulary list + storage keys + language list — edit here
│   ├── storage.js          # localStorage helpers: references, preset-loading, vocab overrides, API settings
│   ├── recognition.js       # Camera capture, tagging, mirror-fix calibration, DTW matching
│   ├── translate.js          # Translation (MyMemory default, Bhashini optional)
│   ├── speech.js              # STT (Web Speech API) + TTS (browser or Bhashini)
│   ├── playback.js             # Reverse translation: skeleton animation player
│   ├── local-config.example.js  # Template for optional background API keys (copy -> local-config.js)
│   └── main.js                   # Wires everything to the DOM
├── data/
│   └── preset-references.json  # Bundled training data, auto-loaded on first run — REPLACE before submission
├── assets/
│   └── og-image.png       # Social preview image (Open Graph / Twitter card)
├── setup.bat            # Windows: checks for Python
└── run.bat              # Windows: starts local server, opens browser
```

Every module has a single, clear responsibility and no circular dependencies
— `main.js` is the only file that touches the DOM outside of the modules'
own constructor functions.

---

## Design system

The interface is intentionally calm rather than "hacker dashboard" dark-mode
— this is an assistive communication tool, and the audience includes people
for whom a stressful or cluttered interface is actively counterproductive.

- **Palette**: soft paper background (`#F4F7F4`), deep teal-slate for text and
  trust (`#1F3B3C`), teal as the primary interactive color (`#2F7A78`), and
  warm amber (`#C98A3F`) as a secondary accent used sparingly.
- **Type**: [Sora](https://fonts.google.com/specimen/Sora) for headings and
  the big recognized-word reveal (rounded, warm, confident); [Inter](https://fonts.google.com/specimen/Inter)
  for everything else (maximum legibility).
- **The one bold moment**: the large "recognized word" reveal — everything
  else stays quiet and disciplined around it.

---

## Shipping your trained data with the repo (important before submission/deployment)

`localStorage` is per-browser — whatever you record only exists on the
machine you recorded it on. To hand someone a working demo without asking
them to re-record everything from scratch:

1. In the app, open **Settings → Training data → Export JSON**.
2. Save the downloaded file as `data/preset-references.json`, **overwriting
   the placeholder that ships in this repo**.
3. Any browser whose local storage is empty will automatically load this
   bundled file on first visit — no import step needed, no setup required
   from whoever opens the app next.

The placeholder file currently in `data/` is intentionally invalid (it's
just a comment explaining this), so the app safely ignores it and starts
empty until you replace it with a real export.

## Custom vocabulary (add/remove trainable words)

The word list in `config.js` is the *default* vocabulary, not a hard limit.
In **Settings → Train New Signs**, you can:

- **Add a word**: type it and click "+ Add word" — it appears in the
  dropdown immediately, saved to this browser.
- **Remove a word**: select it and click "Remove word" — it disappears from
  the dropdown, but any signs already recorded for it are **kept**, not
  deleted. Re-adding the exact same word later makes those recordings
  reappear and become usable again.

This is stored as a small diff (added/removed) on top of `config.js`'s base
list, so the default vocabulary itself never needs editing just to
customize one browser's working list.

## Background API keys (optional, without leaking secrets)

By default nothing requires an API key — MyMemory (translation) and the
browser's own voices (speech) work immediately. If you want the app to use
Bhashini automatically, for every user, without each of them opening
Settings and pasting in credentials themselves:

1. Copy `js/local-config.example.js` to `js/local-config.js`.
2. Fill in your real Bhashini User ID / API Key.
3. That's it — `local-config.js` is already listed in `.gitignore`, so it's
   never committed. A user's own Settings (if they save their own
   credentials) always take priority over this file.

## Running locally

Webcam access and ES module imports require a real server — a plain
double-clicked `index.html` won't work.

**Windows**: double-click `setup.bat` once, then `run.bat` every time.

**Mac/Linux**:
```bash
cd isl-translator
python3 -m http.server 8000
```
Then open `http://localhost:8000` in Chrome or Edge.

---

## Hosting it properly

Sixth-Sense is 100% static — no backend, no build step — so it deploys anywhere
that serves static files over HTTPS (required for camera + microphone
access).

### GitHub Pages — yes, this works great
1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source**: pick the `main` branch, root folder.
3. Your app is live at `https://<username>.github.io/<repo>/` within a
   minute or two.

No configuration needed — GitHub Pages serves plain HTML/CSS/JS as-is, which
is exactly what this is.

### Vercel — also works, arguably faster to set up
1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: **Other** (no build command, no output directory
   override needed — it's already static).
3. Deploy. Vercel gives you a `https://<project>.vercel.app` URL, plus
   automatic HTTPS and a faster global CDN than GitHub Pages by default.

Either is a legitimate choice for demo day; Vercel is slightly nicer if you
want a custom domain or very fast redeploys, GitHub Pages is simplest if the
repo is already on GitHub and you want zero extra accounts involved.

---

## Known limitations (v1, by design)

- **Isolated signs only** — one discrete sign in, one discrete word out. Full
  continuous/sentence-level signing (co-articulated, natural signing speed)
  is an open research problem, not a scope gap in this build.
- **One signer at a time** — camera framing assumes a single centered
  signer, not a crowd.
- **Playback is an approximation** — hands/face are tracked independently
  for matching robustness, so exact physical contact (e.g. a sign that
  touches the cheek) isn't reconstructed pixel-perfectly in the reverse
  animation, though the correct parts and motion are shown.
- **TTS language coverage without Bhashini depends on the device** — this is
  a genuine platform constraint of the Web Speech API, not a bug.

## Roadmap ideas

- Real trained classifier (the recorded template data becomes training data)
  once vocabulary and reliability needs outgrow template matching.
- Continuous/connected signing (CSLR) as its own research effort.
- Better multi-signer / crowd handling.
- Store relative hand-to-face position for signs that need exact contact.
