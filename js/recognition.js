import {
  HolisticLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/vision_bundle.mjs";

const CAPTURE_MS = 2000;
const MATCH_WINDOW_MS = 900;
const MATCH_INTERVAL_MS = 350;
const DIST_THRESHOLD = 0.85;
// The winning match's distance must be no more than this FRACTION of the
// runner-up's distance to be accepted — e.g. 0.75 means the best candidate
// must be at least 25% closer than the next-best different sign. Lower this
// (stricter) if the system still feels like it's guessing between similar
// signs; raise it (more lenient) if confident signs are being rejected.
const CONFIDENCE_MARGIN = 0.75;
const MISSING_PENALTY = 2.5;

const POSE_IDX = [0, 11, 12, 13, 14, 15, 16, 23, 24];
// Order matters — playback.js draws connecting lines assuming this exact order.
// Groups: [nose(1)]
//         [mouth loop, 10pts: leftCorner, upperLip x5, rightCorner, lowerLip x3]
//         [eyebrows, 6pts: leftBrow x3, rightBrow x3]
//         [leftEye, 6pts: outer, upperOuter, upperInner, inner, lowerInner, lowerOuter]
//         [rightEye, 6pts: same pattern]
//         [head contour, 7pts: topLeft, topCenter, topRight, sideRight, chinRight, chinLeft, sideLeft]
const FACE_IDX = [
  1,
  61, 185, 40, 0, 270, 409, 291, 405, 17, 181,
  70, 105, 107, 300, 334, 336,
  33, 160, 158, 133, 153, 144,
  263, 387, 385, 362, 380, 373,
  103, 10, 332, 454, 397, 172, 234
];

function normalizeSet(points, idxList, origin, scale) {
  if (!points || !origin || scale < 1e-4) return null;
  const vec = [];
  for (const i of idxList) {
    const p = points[i];
    if (!p) return null;
    // Negate x: MediaPipe's raw coordinates are in the UN-mirrored camera
    // frame, but the live preview is CSS-mirrored (selfie view) for the
    // signer to watch naturally. Without this flip, stored shapes come out
    // as their own mirror image once replayed — e.g. two hands recorded
    // with pinkies touching in the middle would play back pointing apart.
    // This flip is applied uniformly to every point, so left/right hands'
    // mutual relationship (they're anatomical mirror images of each other)
    // stays correct relative to each other.
    vec.push(-(p.x - origin.x) / scale, (p.y - origin.y) / scale, (p.z || 0) / scale);
  }
  return vec;
}

function normalizeHand(hand) {
  if (!hand || hand.length < 10) return null;
  const wrist = hand[0], midMcp = hand[9];
  if (!wrist || !midMcp) return null;
  const scale = Math.max(0.02, Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y));
  const vec = [];
  for (const p of hand) vec.push(-(p.x - wrist.x) / scale, (p.y - wrist.y) / scale, (p.z || 0) / scale);
  return vec;
}

function extractFrame(result, mirrorFix) {
  const pose = result.poseLandmarks?.[0] || null;
  const rawLeft = result.leftHandLandmarks?.[0] || null;
  const rawRight = result.rightHandLandmarks?.[0] || null;

  // MediaPipe's own left/right hand CLASSIFICATION can be unreliable on its
  // own (it can flicker, especially as hands move near center). When the
  // pose skeleton is visible, we instead assign hand identity by physical
  // proximity to the pose's own wrist points — whichever detected hand is
  // spatially closer to the pose's left wrist genuinely IS the left hand,
  // regardless of what MediaPipe itself labeled it. This is far more robust
  // than trusting the classifier or a fixed mirror assumption.
  let lh = null, rh = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  if (pose && pose[15] && pose[16] && (rawLeft || rawRight)) {
    const poseLeftWrist = pose[15], poseRightWrist = pose[16];
    const candidates = [];
    if (rawLeft) candidates.push(rawLeft);
    if (rawRight) candidates.push(rawRight);

    if (candidates.length === 2) {
      const [a, b] = candidates;
      const costAsIs = dist(a[0], poseLeftWrist) + dist(b[0], poseRightWrist);
      const costSwapped = dist(a[0], poseRightWrist) + dist(b[0], poseLeftWrist);
      if (costAsIs <= costSwapped) { lh = a; rh = b; } else { lh = b; rh = a; }
    } else {
      const c = candidates[0];
      if (dist(c[0], poseLeftWrist) <= dist(c[0], poseRightWrist)) lh = c; else rh = c;
    }
  } else {
    // Fallback: pose/shoulders not visible (e.g. camera framed tight on just
    // the hands) — nothing to anchor against, so fall back to MediaPipe's
    // raw label, corrected by the manual "mirror fix" toggle if needed.
    lh = mirrorFix ? rawRight : rawLeft;
    rh = mirrorFix ? rawLeft : rawRight;
  }

  const face = result.faceLandmarks?.[0] || null;

  let poseVec = null;
  if (pose && pose[11] && pose[12]) {
    const ls = pose[11], rs = pose[12];
    const origin = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const scale = Math.max(0.05, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    poseVec = normalizeSet(pose, POSE_IDX, origin, scale);
  }

  let faceVec = null;
  if (face && face[133] && face[362] && face[1]) {
    faceVec = buildFaceVec(face, null);
  }

  return { pose: poseVec, left: normalizeHand(lh), right: normalizeHand(rh), face: faceVec, rawLeft: lh, rawRight: rh, rawFace: face };
}

// Face scale (interocular distance) is recomputed here so it can also be
// overridden with a STABLE, take-wide scale after recording — see
// recordReference(). Without that, tilting your head (e.g. touching your
// cheek) shrinks the per-frame interocular distance from foreshortening,
// which inflates every point's magnitude more each frame — the farthest
// point (top of head) balloons outward the most, which looks like the head
// "growing"/drifting upward over the course of the recording.
function computeFaceOriginScale(rawFace) {
  if (!rawFace || !rawFace[133] || !rawFace[362] || !rawFace[1]) return null;
  const origin = { x: rawFace[1].x, y: rawFace[1].y };
  const scale = Math.max(0.03, Math.hypot(rawFace[133].x - rawFace[362].x, rawFace[133].y - rawFace[362].y));
  return { origin, scale };
}

function buildFaceVec(rawFace, forcedScale) {
  const os = computeFaceOriginScale(rawFace);
  if (!os) return null;
  return normalizeSet(rawFace, FACE_IDX, os.origin, forcedScale || os.scale);
}

function resampleFrames(seq, targetLen) {
  if (seq.length === targetLen) return seq;
  const out = [];
  for (let i = 0; i < targetLen; i++) {
    const t = (i * (seq.length - 1)) / Math.max(1, targetLen - 1);
    out.push(seq[Math.min(Math.round(t), seq.length - 1)]);
  }
  return out;
}

function frameDist(fa, fb, meta) {
  let total = 0, count = 0;
  const parts = [];
  if (meta.right) parts.push("right");
  if (meta.left) parts.push("left");
  if (meta.face) parts.push("face");
  parts.push("pose");

  for (const part of parts) {
    const weight = part === "pose" ? 0.25 : 1.0;
    const va = fa[part], vb = fb[part];
    if (!va || !vb) {
      if (part !== "pose" && meta[part]) { total += MISSING_PENALTY * weight; count++; }
      continue;
    }
    let s = 0;
    for (let i = 0; i < va.length; i++) { const d = va[i] - vb[i]; s += d * d; }
    total += Math.sqrt(s) * weight;
    count++;
  }
  return count ? total / count : MISSING_PENALTY;
}

function dtwDistance(seqA, seqB, meta) {
  const n = seqA.length, m = seqB.length;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = frameDist(seqA[i - 1], seqB[j - 1], meta);
      D[i][j] = cost + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
    }
  }
  return D[n][m] / (n + m);
}

/**
 * Creates a recognition engine bound to a given video + canvas element.
 * @param {Object} opts
 * @param {HTMLVideoElement} opts.videoEl
 * @param {HTMLCanvasElement} opts.canvasEl
 * @param {() => Object} opts.getReferences - returns current references object
 * @param {(refs:Object) => void} opts.onReferencesChange
 * @param {(status:string, kind?:string) => void} opts.onStatus
 * @param {(word:string|null, dist:number) => void} opts.onMatch - fired continuously while matching
 */
export function createRecognitionEngine({ videoEl, canvasEl, getReferences, onReferencesChange, onStatus, onMatch }) {
  const ctx = canvasEl.getContext("2d");
  let landmarker = null;
  let liveBuffer = [];
  let isMatching = false;
  let matchLoopHandle = null;
  let rafHandle = null;
  let mirrorFix = true; // default; calibrate per-device via setMirrorFix()

  function drawPoint(p, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x * canvasEl.width, p.y * canvasEl.height, 2.5, 0, 7);
    ctx.fill();
  }

  function loop() {
    if (landmarker && videoEl.readyState >= 2) {
      const result = landmarker.detectForVideo(videoEl, performance.now());
      const frame = extractFrame(result, mirrorFix);

      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      result.poseLandmarks?.[0]?.forEach(p => drawPoint(p, "#2F7A78"));
      // Colors reflect the SAME assignment logic used for recording/matching
      // (pose-wrist proximity when available) — what you see here is what
      // actually gets tagged as "left"/"right".
      if (frame.rawLeft) frame.rawLeft.forEach(p => drawPoint(p, "#C98A3F"));
      if (frame.rawRight) frame.rawRight.forEach(p => drawPoint(p, "#6FA98A"));
      result.faceLandmarks?.[0]?.forEach(p => drawPoint(p, "#B15D8E"));

      liveBuffer.push({ t: performance.now(), frame });
      const cutoff = performance.now() - Math.max(CAPTURE_MS, MATCH_WINDOW_MS) - 200;
      liveBuffer = liveBuffer.filter(f => f.t >= cutoff);
    }
    rafHandle = requestAnimationFrame(loop);
  }

  async function init() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: canvasEl.width, height: canvasEl.height }, audio: false });
    videoEl.srcObject = stream;
    await new Promise(r => (videoEl.onloadedmetadata = r));

    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm"
    );
    landmarker = await HolisticLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      minFaceDetectionConfidence: 0.5,
      minHandLandmarksConfidence: 0.5,
      minPoseDetectionConfidence: 0.5
    });

    onStatus("Camera ready", "ok");
    loop();
  }

  // Returns the best-matching word AND how convincingly it won against the
  // next-best DIFFERENT sign. A single absolute distance threshold is
  // fragile: if nothing genuinely matches, whatever happens to be
  // "least bad" can still slip under a lenient threshold, which looks like
  // the system guessing. Requiring a clear margin over the runner-up
  // (a different word's best take) is a much more robust rejection rule —
  // it only accepts a match when one specific sign is convincingly closer
  // than every other candidate, not just numerically under some cutoff.
  function bestMatch(liveSeqRaw) {
    const references = getReferences();
    const live = resampleFrames(liveSeqRaw, 20);
    const candidates = []; // { word, dist }

    for (const word of Object.keys(references)) {
      let bestForWord = Infinity;
      for (const take of references[word]) {
        const target = resampleFrames(take.frames, 20);
        const d = dtwDistance(live, target, take.meta);
        if (d < bestForWord) bestForWord = d;
      }
      if (bestForWord < Infinity) candidates.push({ word, dist: bestForWord });
    }

    if (candidates.length === 0) return { word: null, dist: Infinity, runnerUpDist: Infinity };
    candidates.sort((a, b) => a.dist - b.dist);
    const best = candidates[0];
    const runnerUp = candidates[1]; // best distance among every OTHER word
    return { word: best.word, dist: best.dist, runnerUpDist: runnerUp ? runnerUp.dist : Infinity };
  }

  async function recordReference(word, meta) {
    if (!meta.right && !meta.left) {
      onStatus("Tag at least one hand as relevant before recording", "warn");
      return false;
    }
    onStatus(`Recording "${word}"…`, "rec");
    const startT = performance.now();
    await new Promise(r => setTimeout(r, CAPTURE_MS));
    const frames = liveBuffer.filter(f => f.t >= startT).map(f => f.frame);

    const rightOk = !meta.right || frames.some(f => f.right);
    const leftOk = !meta.left || frames.some(f => f.left);
    const faceOk = !meta.face || frames.some(f => f.face);

    if (frames.length < 5) {
      onStatus("Too few frames captured — try again", "warn");
      return false;
    }
    if (!rightOk || !leftOk || !faceOk) {
      onStatus("Couldn't detect the tagged part(s) throughout — reposition and retry", "warn");
      return false;
    }

    // Stabilize face scale across the WHOLE take (median interocular
    // distance) instead of each frame using its own — prevents head
    // tilt (e.g. touching your cheek) from making the face balloon/drift
    // over the course of the recording. Only affects stored/playback data.
    if (meta.face) {
      const scales = frames.map(f => computeFaceOriginScale(f.rawFace)?.scale).filter(Boolean);
      if (scales.length) {
        scales.sort((a, b) => a - b);
        const stableFaceScale = scales[Math.floor(scales.length / 2)];

        // The offset from wrist to face must be expressed in the SAME unit
        // that playback will multiply it by (HAND_SCALE) — otherwise "how
        // far the hand is from the face" and "how big the hand is" use two
        // different real-world scales and the composed result stretches out
        // of proportion. So this uses a stable HAND scale (wrist-to-palm
        // size), not the face's interocular-distance scale.
        const handScaleOf = (raw) => {
          if (!raw || !raw[0] || !raw[9]) return null;
          return Math.max(0.02, Math.hypot(raw[0].x - raw[9].x, raw[0].y - raw[9].y));
        };
        const medianOf = (arr) => { const s = arr.filter(Boolean).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
        const stableLeftHandScale = meta.left ? medianOf(frames.map(f => handScaleOf(f.rawLeft))) : null;
        const stableRightHandScale = meta.right ? medianOf(frames.map(f => handScaleOf(f.rawRight))) : null;

        frames.forEach(f => {
          if (!f.rawFace) return;
          f.face = buildFaceVec(f.rawFace, stableFaceScale);
          const nose = f.rawFace[1];
          if (meta.left && f.rawLeft && stableLeftHandScale) {
            f.leftRelToFace = [-(f.rawLeft[0].x - nose.x) / stableLeftHandScale, (f.rawLeft[0].y - nose.y) / stableLeftHandScale];
          }
          if (meta.right && f.rawRight && stableRightHandScale) {
            f.rightRelToFace = [-(f.rawRight[0].x - nose.x) / stableRightHandScale, (f.rawRight[0].y - nose.y) / stableRightHandScale];
          }
        });
      }
    }

    // Strip raw/preview-only fields before storing — playback and matching
    // only need pose/left/right/face/leftRelToFace/rightRelToFace.
    const cleanedFrames = frames.map(({ pose, left, right, face, leftRelToFace, rightRelToFace }) =>
      ({ pose, left, right, face, leftRelToFace, rightRelToFace }));

    const references = getReferences();
    references[word] = references[word] || [];
    references[word].push({ meta, frames: cleanedFrames });
    onReferencesChange(references);
    onStatus(`Saved take #${references[word].length} for "${word}"`, "ok");
    return true;
  }

  function undoLast(word) {
    const references = getReferences();
    const takes = references[word] || [];
    takes.pop();
    if (takes.length === 0) delete references[word];
    onReferencesChange(references);
  }

  function clearWord(word) {
    const references = getReferences();
    delete references[word];
    onReferencesChange(references);
  }

  function startMatching() {
    if (isMatching) return;
    isMatching = true;
    matchLoopHandle = setInterval(() => {
      const cutoff = performance.now() - MATCH_WINDOW_MS;
      const seq = liveBuffer.filter(f => f.t >= cutoff).map(f => f.frame);
      const references = getReferences();
      if (seq.length < 5 || Object.keys(references).length === 0) return;

      const { word, dist, runnerUpDist } = bestMatch(seq);
      const passesAbsolute = word && dist <= DIST_THRESHOLD;
      // If there's only one trained word total, there's no runner-up to
      // compare against — fall back to the absolute threshold alone.
      const passesMargin = runnerUpDist === Infinity || dist <= runnerUpDist * CONFIDENCE_MARGIN;

      onMatch((passesAbsolute && passesMargin) ? word : null, dist);
    }, MATCH_INTERVAL_MS);
  }

  function stopMatching() {
    isMatching = false;
    clearInterval(matchLoopHandle);
  }

  function destroy() {
    stopMatching();
    if (rafHandle) cancelAnimationFrame(rafHandle);
    const stream = videoEl.srcObject;
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  function setMirrorFix(value) { mirrorFix = value; }

  return { init, recordReference, undoLast, clearWord, startMatching, stopMatching, destroy, setMirrorFix, get isMatching() { return isMatching; } };
}
