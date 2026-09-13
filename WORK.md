# WORK.md — Technical Deep Dive: Sixth-Sense

This document explains, at an implementation level, every algorithm, library,
and design decision behind Sixth-Sense. It is written for technical review
(judges, contributors, or future-you six months from now) — not a user guide.
For setup/usage, see `README.md`.

---

## 1. Problem framing and why the architecture looks the way it does

Indian Sign Language recognition is not "just track the hands." ISL, like
most sign languages, encodes meaning through **hands (shape, orientation,
motion), face (expression, mouth patterns), and head/body position**
simultaneously. A hands-only system cannot represent this. Conversely, a
system that tries to solve *continuous* sign language recognition (CSLR —
free-flowing sentences with co-articulated signs) is an open research
problem; no team solves that correctly in a hackathon timeframe, and
claiming otherwise would be dishonest.

Given that constraint, the project deliberately scopes to:

- **Isolated sign recognition** (one discrete sign → one discrete word),
  not continuous signing.
- **Deterministic template matching**, not a trained neural classifier —
  because training a real classifier needs a labeled dataset at a scale
  this project's timeline doesn't allow, and a template-matching system is
  honest about its own limitations rather than pretending to be more than
  it is.
- **100% client-side execution** — no backend, so there's nothing to
  deploy/host beyond static files, no server cost, and no video ever leaves
  the user's device (privacy-relevant for an accessibility tool).

---

## 2. Capture pipeline: MediaPipe Holistic Landmarker

**Library**: `@mediapipe/tasks-vision` (Google), `HolisticLandmarker`, loaded
from a CDN, running on WASM/GPU delegate directly in the browser.

**Why Holistic and not just a hand-tracking model**: Holistic returns **543
landmarks per frame** in one pass — 33 pose points, 468 face mesh points,
and 21 points per hand — solving the "not just hands" requirement in a
single model call rather than stitching together separate pose/hand/face
models with their own inconsistent coordinate spaces.

```
HolisticLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: <holistic_landmarker.task>, delegate: "GPU" },
  runningMode: "VIDEO"
})
```

Of the 468 face points, only a curated subset (36, detailed in §5) is
actually used — full-mesh precision isn't needed for this use case and
would bloat every recorded reference for no benefit.

---

## 3. Coordinate normalization — the core of why this generalizes at all

Raw landmark coordinates are useless for matching directly: they encode
*where in the frame* something was, which varies with camera distance,
framing, and position — not *what shape* was made. Every landmark group is
normalized **independently**, each against its own local origin/scale:

| Component | Origin | Scale unit |
|---|---|---|
| Pose | Shoulder midpoint | Shoulder width |
| Each hand | That hand's wrist (landmark 0) | Wrist-to-middle-MCP distance (landmark 9) |
| Face | Nose tip | Interocular distance (inner eye corners) |

```js
vec.push(-(p.x - origin.x) / scale, (p.y - origin.y) / scale, (p.z||0) / scale);
```

**Why independent normalization** (not one global scale for the whole
body): a hand-only sign shouldn't require the shoulders to even be in
frame. Normalizing each hand by its own size means recognition works
whether the camera is a full-body shot or cropped tight to just the hands —
there's nothing in the hand's normalized vector that depends on anything
outside the hand itself.

### 3.1 The mirror-flip correction (`-(p.x - origin.x)`)

MediaPipe returns coordinates in the **raw, un-mirrored** camera frame. The
live preview is CSS-mirrored (`transform: scaleX(-1)`) so the signer can
watch themselves naturally, like a mirror. Without correcting for this
mismatch, every stored shape comes out as **its own mirror image** once
replayed — this was an actual bug found during testing (recorded pinky
fingers that should touch in the middle rendered pointing apart). The fix
negates the x-component consistently everywhere a raw coordinate is
normalized, so stored data matches the mirrored convention the signer
actually saw while recording. Because the flip is applied uniformly, it
doesn't break DTW matching (a global sign flip cancels out in any distance
calculation applied consistently to both sides).

---

## 4. Hand identity: proximity-based assignment, not MediaPipe's own classifier

This went through two iterations, both documented here because the reasoning
matters for anyone extending this:

**v1 (retired)**: trust MediaPipe's own `leftHandLandmarks`/`rightHandLandmarks`
labels, with a manual "mirror fix" toggle to correct for devices whose raw
feed convention differs. This worked inconsistently — MediaPipe's own
handedness *classification* can flicker, especially as hands move near the
body's center, so no fixed toggle position was ever fully reliable.

**v2 (current)**: assign hand identity by **physical proximity to the pose
skeleton's own wrist landmarks** (raw pose indices 15 and 16). Whichever
detected hand is spatially closer to the pose's left-wrist point genuinely
*is* the left hand, regardless of what MediaPipe's classifier called it:

```js
const costAsIs   = dist(handA.wrist, poseLeftWrist) + dist(handB.wrist, poseRightWrist);
const costSwapped = dist(handA.wrist, poseRightWrist) + dist(handB.wrist, poseLeftWrist);
// pick whichever pairing has lower total cost
```

This only works when the pose skeleton (shoulders) is visible. **Fallback**:
if the camera is framed tight enough that shoulders aren't detected, there's
nothing to anchor against, so the system falls back to MediaPipe's raw
label corrected by the manual toggle — calibrated per-device by raising one
hand and checking which color lights up.

---

## 5. The per-sign tagging system

Every recorded reference is tagged with **which body parts are actually
relevant**: right hand, left hand, face. This is stored per-take as
`meta = { right, left, face }`. Untagged components are **fully excluded**
from the matching distance calculation — not down-weighted, excluded. This
solves a concrete problem: if a fingerspelled letter is hand-only, the
signer's incidental facial expression during recording must never affect
whether that sign matches later, since expression varies session to session
for reasons unrelated to the sign itself.

---

## 6. Face landmark model (36 points)

The face representation went through several redesigns based on legibility
testing. The final layout tracks 36 of MediaPipe's 468 face-mesh points,
grouped and connected as:

- **Mouth** (10 pts, closed loop): 2 corners + 5 upper-lip + 3 lower-lip
  points (indices 61, 185, 40, 0, 270, 409, 291, 405, 17, 181).
- **Eyes** (6 pts each, closed loop): outer corner, upper-outer lid,
  upper-inner lid, inner corner, lower-inner lid, lower-outer lid — enough
  to read as an actual eye shape, not a single dot.
- **Eyebrows** (3 pts each, open chain): outer, mid, inner — two connected
  line segments per brow.
- **Head contour** (7 pts, closed loop): 3 across the forehead, 2 at the
  temples, 2 near the chin — an actual tracked outline rather than a
  fixed decorative shape.

**Rendering**: shapes are drawn as **smooth curves through the points**
(quadratic Bézier through each edge's midpoint, using the vertex itself as
the curve's control point) rather than straight polygon edges. With only
6–10 points per shape, straight lines read as an angular, unrecognizable
polygon; the curve-smoothing pass is what actually makes it read as "an
eye" or "a mouth" to a human viewer.

### 6.1 Scale stability (a real bug, now fixed)

Originally, face scale (interocular distance) was recomputed **fresh every
frame**. Tilting the head (e.g. to touch the cheek) foreshortens the
apparent 2D distance between the eyes, so a per-frame scale shrinks as the
head tilts — and since every point's magnitude is divided by that shrinking
number, the whole face progressively "balloons" outward, worst at the
farthest points (the head contour). The fix: compute one **stable scale**
(the median interocular distance across the entire 2-second recording) and
re-normalize every frame in that take using that one fixed number, instead
of each frame's own transient value.

---

## 7. Reverse translation: hand-to-face relative positioning

For signs that touch the face, showing the hand and face as two
independently-anchored shapes (as in an earlier version) can never convey
actual contact — neither component retains any information about the
other's position, by construction (each is normalized against its own
local origin for matching robustness). Fixing this required capturing an
**explicit relative-position field**, computed only at record time (not
needed for live matching):

```js
leftRelToFace = [ -(wristX - noseX) / handScale, (wristY - noseY) / handScale ]
```

**The critical detail**: this offset must be expressed in the **same scale
unit that will multiply it during rendering**. An early version normalized
the offset by the *face's* scale (interocular distance) but rendered it
using the *hand's* draw scale — two different real-world units — which
stretched the hand's rendered position wildly out of proportion. The fix
uses a stable **hand-scale** unit (median wrist-to-palm distance across the
take) for both computing and rendering the offset, so "how far the hand is
from the face" and "how big the hand is drawn" share one consistent scale
and compose correctly.

---

## 8. Matching algorithm: Dynamic Time Warping (DTW)

Recognition compares a rolling ~0.9-second window of live landmarks against
every stored reference take, using DTW rather than a fixed-length distance
metric — because signs are performed at variable speed, and DTW finds the
lowest-cost alignment between two sequences of different lengths/pacing.

```
D[i][j] = frameCost(live[i], ref[j]) + min(D[i-1][j], D[i][j-1], D[i-1][j-1])
```

**Per-frame cost function** is tag-aware: only components marked relevant
in that reference's `meta` contribute to the cost; a missing *required*
component (e.g. the tagged hand briefly leaves frame) incurs an explicit
penalty rather than being silently ignored, so genuinely incomplete signing
is correctly penalized. Pose is always included as a low-weight (0.25×)
soft cue — never decisive on its own.

Sequences are resampled to a fixed length (20 frames) before DTW to bound
computation; complexity is O(n·m) per reference comparison, trivial at
hackathon vocabulary scale (tens of words × a few takes each).

A **confidence threshold** (tunable constant) determines whether the
closest match is reported at all — below-threshold results report "no
match" rather than guessing, which is what makes the system's output
deterministic (a specific input either confidently maps to one specific
output, or to nothing) rather than always forcing some answer.

**A single absolute threshold alone proved fragile in testing**: if the
live gesture didn't genuinely match anything, whatever candidate happened
to be "least bad" could still slip under a lenient threshold — which looks
identical to the system guessing. The fix adds a **confidence-margin
check**: the winning match's distance must not just clear the absolute
threshold, it must also be meaningfully closer than the best distance among
every *other* word (the runner-up). A match is only accepted when one
specific sign is convincingly closer than all alternatives — not merely
numerically under some cutoff — which is a standard, more robust rejection
rule (the same idea as a ratio test in nearest-neighbor matching).

---

## 9. Speech and translation layer

- **STT**: browser-native `SpeechRecognition` (Web Speech API). No API key,
  no setup — Chrome/Edge ship this built-in, backed by Google's speech
  service over the network.
- **TTS default**: browser-native `SpeechSynthesisUtterance`, using whatever
  voices are installed on the OS/browser. This is a genuine platform
  limitation (voice availability varies by device) surfaced honestly in the
  UI rather than hidden.

### 9.1 Translation: a deliberate three-layer fallback chain

Rather than depending on one translation source, `translate.js` tries three
engines in order, each existing for a specific reason, falling through
automatically on any failure so the app never simply breaks mid-demo:

1. **Bhashini** (only if the user has entered credentials in Settings) —
   India's National Language Translation Mission platform. Purpose-built
   for all 22 official Indian languages, so it's tried first *when
   available* because it's the best-quality option specifically for the
   languages this project targets. Integration follows Bhashini's two-step
   call pattern:
   - **Config call** to `getModelsPipeline` (authenticated with a User ID +
     API key) returns a `serviceId` and a per-session `inferenceApiKey` +
     callback URL for the requested language pair/task.
   - **Compute call** to that callback URL, authenticated with the
     session's inference key, actually performs the translation and
     returns the result.
2. **Chrome's built-in Translator API** (`window.Translator`, stable since
   Chrome 138, desktop only) — tried next because it's genuinely good
   quality, requires no API key or registration at all, and runs entirely
   **on-device**: the translation model downloads once per language pair
   on first use, then every subsequent call is local, fast, and offline.
   This is not available in Edge, Firefox, Safari, or any mobile browser,
   so it's a bonus tier the app benefits from when present, never a
   dependency.
3. **MyMemory** (free public API, works in any browser) — the final,
   guaranteed fallback. It's a crowd-sourced "translation memory" service
   rather than a proper neural MT engine, so quality is noticeably weaker
   than the two tiers above it; it exists purely so the app *always*
   produces a result, everywhere, even with zero configuration and on a
   browser with none of the fancier options available.

`speech.js` follows the same two-tier pattern for text-to-speech (Bhashini
if configured, otherwise the browser's own installed voices) — the app
never hard-depends on any paid or registration-gated service.

---

## 10. Software architecture

Vanilla JS, ES modules, no build step, no framework — deliberately, so the
entire app is just static files servable from anywhere (GitHub Pages,
Vercel, a plain `python -m http.server`).

```
config.js       — vocabulary list, language list, storage keys (single source of truth)
storage.js      — localStorage read/write + schema validation for references & API settings
recognition.js  — capture, normalization, hand-identity resolution, tagging, DTW matching
translate.js    — MyMemory / Bhashini translation, with fallback
speech.js       — Web Speech API STT, browser/Bhashini TTS, with fallback
playback.js     — reverse-translation rendering (neon skeleton animation)
main.js         — DOM wiring only; no business logic lives here
```

Each module has one responsibility and no circular dependencies —
`main.js` is the only file that touches the DOM directly.

**Storage**: recorded references and API settings persist in
`localStorage` as JSON. A schema-validation guard on load detects data from
an incompatible earlier version and clears it safely (with a visible
notice) rather than crashing on a shape mismatch.

---

## 11. Non-functional qualities: performance, scalability, privacy, responsiveness, discoverability

These weren't afterthoughts — each is a direct consequence of specific
choices made earlier in this document, worth stating explicitly rather than
leaving implicit.

**Lightweight, works on slow connections.** The entire app is plain
HTML/CSS/JS with zero build step and zero framework — no bundler, no
compile step, no megabytes of framework runtime to download before
anything works. The only network dependency at load time is the MediaPipe
model files (fetched from a CDN) and Google Fonts; everything else is the
app's own small source files. This matters concretely for the target
audience: a school or NGO on a modest internet connection can load this
reliably where a heavier SPA framework bundle might struggle.

**Fully client-side — no server, which is also what makes it scalable.**
Every part of the pipeline (camera capture, landmark extraction, DTW
matching, playback rendering) runs in the visitor's own browser. There is
no application server processing requests, so there is no server to
provision, scale, or pay for as usage grows — serving 10 users costs
exactly the same (nothing, on GitHub Pages/Vercel's free static tiers) as
serving 10,000, because a static file host is just handing out the same
unchanging files regardless of visitor count. This is a materially
different scaling story than a typical server-rendered or API-backed app.

**Privacy is a structural property, not a policy promise.** Video from the
camera is processed by MediaPipe entirely in-browser and is never uploaded
anywhere — there is no endpoint it could be sent to, because there is no
backend. The only data that ever leaves the device is what the user
explicitly triggers: a translation API call (Bhashini/MyMemory) or Chrome's
own on-device model download. Recorded sign data lives in the browser's own
`localStorage` unless the user deliberately exports it. This isn't "we
promise not to look at your data" — there is no mechanism by which the
video *could* reach anyone else.

**Responsive layout.** `style.css` defines breakpoints at 900px (stacks the
camera and "recognized text" columns instead of sitting them side-by-side)
and 640px/400px (shrinks header, card padding, button sizing, and lets the
tab pills wrap) so the interface holds up from a phone-sized viewport up
through desktop, rather than only being designed for one screen size.

**SEO / discoverability.** `index.html` includes a real `<meta
name="description">`, a `<meta name="keywords">` list, `robots` /
`theme-color` tags, a favicon, and full Open Graph + Twitter Card metadata
with a purpose-built social preview image (`assets/og-image.png`) — so a
shared link renders a proper preview card instead of a bare URL, and search
engines have an actual description to index rather than guessing from raw
markup.

---

## 12. Known limitations (stated plainly, not hidden)

- **Isolated signs only.** Continuous/connected signing (real sentence-speed
  signing with co-articulation) is not attempted — it's an open research
  problem (CSLR), not a scope gap in this build.
- **Single signer, framed reasonably centrally.** No multi-person/crowd
  handling.
- **Template matching, not a trained model.** Generalization is bounded by
  how much and how varied the recorded reference data is. This is the
  correct trade-off for a 1-day build's deterministic, explainable behavior,
  but a production system would eventually want the same recorded data
  repurposed as training data for a real sequence classifier (GRU/LSTM/
  ST-GCN over the same landmark features).
- **Playback is a faithful-but-approximate visualization**, not a
  photorealistic avatar — it renders exactly what was recorded, with the
  scale-consistency fixes described in §7, but is still a schematic
  skeleton, not a rendered human hand/face.
- **TTS voice coverage without Bhashini depends on the user's device/OS** —
  a genuine platform constraint of the Web Speech API.

## 13. Submission/distribution additions

Three additions made specifically to get from "working prototype on one
developer's machine" to "a repo someone else can clone and get a working
demo from," without changing the recognition/playback algorithms themselves.

### 13.1 Bundled preset data

`localStorage` is inherently per-browser, so trained reference data never
leaves the machine it was recorded on unless explicitly exported. Rather
than requiring every new environment (a judge's laptop, a fresh clone, a
teammate's machine) to re-record the entire vocabulary, `storage.js` exposes
`loadPresetReferencesIfEmpty()`, called once at startup:

```js
if (Object.keys(currentReferences).length > 0) return null; // never clobber real local data
const res = await fetch("./data/preset-references.json");
// ...validate shape, return parsed data or null on any failure
```

This only ever *fills an empty store* — it will never overwrite data
someone has actually recorded in that browser, and any fetch/parse failure
degrades silently to an empty start rather than breaking the app. The
bundled file must be replaced with a real `Export JSON` output before
relying on this for a demo; the placeholder ships intentionally invalid so
it's never mistaken for real (but empty-looking) data.

### 13.2 Vocabulary as a diff over a base list

Rather than making `config.js`'s word list directly user-editable (which
would mean editing source code per browser, or losing customizations on
every code update), the effective vocabulary is computed as a **diff**:

```js
computeEffectiveVocab(overrides) =
  BASE_VOCAB.filter(w => !overrides.removed.includes(w)) + overrides.added
```

`overrides = { added: [...], removed: [...] }` persists per-browser in
`localStorage`, entirely separate from `config.js`. This keeps the shipped
default vocabulary as a single source of truth in source control, while
still letting any deployment customize its working word list without
touching code. Removing a word only removes it from the *selectable* list —
already-recorded reference data for that word string is untouched in
storage, and re-adding the identical word string makes it reappear, which
is a deliberate safety net against accidental removal.

### 13.3 Optional background API credentials without leaking secrets

Two competing needs: (a) a demo should be able to "just work" with Bhashini
configured, without asking every single user to open Settings and paste in
credentials; (b) real API keys must never end up committed to a public
repository. Resolved with a gitignored local file and a layered priority
in `loadApiSettings()`:

```js
priority: explicit user-saved Settings  >  js/local-config.js (gitignored)  >  built-in blank defaults
```

`js/local-config.example.js` ships in the repo as a safe, secret-free
template; a developer copies it to `js/local-config.js` (excluded via
`.gitignore`) and fills in real values locally or on a deployment target.
The dynamic `import("./local-config.js")` is wrapped in a try/catch
specifically because the file is expected to be *absent* in a fresh clone —
that's not an error state, it's the normal "no Bhashini configured yet"
path, and the app falls through to the free defaults exactly as it always
has.

## 14. What would change for a production system (not attempted here)

- Replace template matching with a trained temporal classifier once enough
  labeled data exists (the recorded takes are already in the right shape to
  become a training set).
- Tackle CSLR for continuous signing as its own dedicated effort.
- Add real multi-signer detection/selection (e.g. largest bounding box or
  most-central person, discarding others before landmark extraction).
- Store true 3D-consistent relative positioning across *all* tagged
  components (not just hand-to-face) if more contact-based signs are added.
