// ---------------------------------------------------------------------------
// Reverse translation: replays recorded landmark sequences as an animated
// skeleton, drawing ONLY the parts tagged relevant for that sign. Rendered
// as bright, glowing ("neon") outlines against a dark stage — sharp lines
// with a soft glow read far more clearly as a hand/face shape than plain
// scattered dots.
//
// Limitation (documented, not hidden): hands/face are normalized independently
// of each other for matching robustness, so we don't retain their true
// relative on-screen position. Signs tagged Face+Hand together will show both
// as separate anchored groups — correct content, not exact physical contact.
// ---------------------------------------------------------------------------

const HAND_SCALE = 70;
const FACE_SCALE = 46;

const NEON = {
  left: "#FFC15E",   // neon amber
  right: "#4CEBD8",  // neon cyan
  face: "#FF6FC8"    // neon pink
};

const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

// Matches FACE_IDX order in recognition.js exactly. Index 0 is the nose;
// everything after is grouped as: mouth(10) -> eyebrows(6) -> leftEye(6) ->
// rightEye(6) -> head contour(7).
const FACE_POINT = {
  nose: 0,
  mouthLeftCorner: 1, mouthUpper1: 2, mouthUpper2: 3, mouthUpper3: 4, mouthUpper4: 5, mouthUpper5: 6,
  mouthRightCorner: 7, mouthLower1: 8, mouthLower2: 9, mouthLower3: 10,
  leftBrowOuter: 11, leftBrowMid: 12, leftBrowInner: 13,
  rightBrowOuter: 14, rightBrowMid: 15, rightBrowInner: 16,
  leftEyeOuter: 17, leftEyeUpperOuter: 18, leftEyeUpperInner: 19, leftEyeInner: 20, leftEyeLowerInner: 21, leftEyeLowerOuter: 22,
  rightEyeOuter: 23, rightEyeUpperOuter: 24, rightEyeUpperInner: 25, rightEyeInner: 26, rightEyeLowerInner: 27, rightEyeLowerOuter: 28,
  headTopLeft: 29, headTopCenter: 30, headTopRight: 31, headSideRight: 32, headChinRight: 33, headChinLeft: 34, headSideLeft: 35
};

const MOUTH_LOOP = ["mouthLeftCorner", "mouthUpper1", "mouthUpper2", "mouthUpper3", "mouthUpper4", "mouthUpper5",
  "mouthRightCorner", "mouthLower1", "mouthLower2", "mouthLower3"];
const LEFT_BROW = ["leftBrowOuter", "leftBrowMid", "leftBrowInner"];
const RIGHT_BROW = ["rightBrowOuter", "rightBrowMid", "rightBrowInner"];
const LEFT_EYE_LOOP = ["leftEyeOuter", "leftEyeUpperOuter", "leftEyeUpperInner", "leftEyeInner", "leftEyeLowerInner", "leftEyeLowerOuter"];
const RIGHT_EYE_LOOP = ["rightEyeOuter", "rightEyeUpperOuter", "rightEyeUpperInner", "rightEyeInner", "rightEyeLowerInner", "rightEyeLowerOuter"];
const HEAD_CONTOUR_LOOP = ["headTopLeft", "headTopCenter", "headTopRight", "headSideRight", "headChinRight", "headChinLeft", "headSideLeft"];

function anchorsFor(meta, frame, w, h) {
  const both = meta.left && meta.right;
  const cy = h * 0.68;
  const faceAnchor = { x: w * 0.5, y: h * 0.22 };
  const defaultLeft = both ? { x: w * 0.33, y: cy } : { x: w * 0.5, y: cy };
  const defaultRight = both ? { x: w * 0.67, y: cy } : { x: w * 0.5, y: cy };

  // When this sign is tagged with Face AND we captured the hand's real
  // position relative to the face (see recognition.js), use that instead of
  // the generic fixed anchor — this is what actually shows a hand touching
  // the cheek rather than two disconnected floating shapes.
  const left = (meta.face && frame.leftRelToFace)
    ? { x: faceAnchor.x + frame.leftRelToFace[0] * HAND_SCALE, y: faceAnchor.y + frame.leftRelToFace[1] * HAND_SCALE }
    : defaultLeft;
  const right = (meta.face && frame.rightRelToFace)
    ? { x: faceAnchor.x + frame.rightRelToFace[0] * HAND_SCALE, y: faceAnchor.y + frame.rightRelToFace[1] * HAND_SCALE }
    : defaultRight;

  return { left, right, face: faceAnchor };
}

function neonStroke(ctx, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
}
function clearGlow(ctx) { ctx.shadowBlur = 0; }

export function createPlaybackEngine({ canvasEl }) {
  const ctx = canvasEl.getContext("2d");
  const W = canvasEl.width, H = canvasEl.height;

  function drawHand(handVec, anchor, color) {
    if (!handVec) return;
    const pts = [];
    for (let i = 0; i < 21; i++) {
      pts.push({ x: anchor.x + handVec[i * 3] * HAND_SCALE, y: anchor.y + handVec[i * 3 + 1] * HAND_SCALE });
    }
    neonStroke(ctx, color, 2.5);
    HAND_BONES.forEach(([a, b]) => {
      ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
    });
    clearGlow(ctx);
    ctx.fillStyle = color;
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }

  function drawLoop(pt, names, color, width) {
    const pts = names.map(pt);
    const n = pts.length;
    neonStroke(ctx, color, width);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const curr = pts[i], next = pts[(i + 1) % n];
      const midX = (curr.x + next.x) / 2, midY = (curr.y + next.y) / 2;
      if (i === 0) {
        const prev = pts[(i - 1 + n) % n];
        ctx.moveTo((prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
      }
      ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
    }
    ctx.closePath();
    ctx.stroke();
    clearGlow(ctx);
  }

  function drawChain(pt, names, color, width) {
    neonStroke(ctx, color, width);
    ctx.beginPath();
    names.forEach((name, i) => {
      const p = pt(name);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    clearGlow(ctx);
  }

  function drawFace(faceVec, anchor, color) {
    if (!faceVec) return;
    const pt = (name) => {
      const i = FACE_POINT[name] * 3;
      return { x: anchor.x + faceVec[i] * FACE_SCALE, y: anchor.y + faceVec[i + 1] * FACE_SCALE };
    };

    drawLoop(pt, HEAD_CONTOUR_LOOP, color, 1.75);
    drawLoop(pt, MOUTH_LOOP, color, 2.5);
    drawLoop(pt, LEFT_EYE_LOOP, color, 2);
    drawLoop(pt, RIGHT_EYE_LOOP, color, 2);
    drawChain(pt, LEFT_BROW, color, 2.5);
    drawChain(pt, RIGHT_BROW, color, 2.5);

    ctx.fillStyle = color;
    const nose = pt("nose");
    ctx.beginPath(); ctx.arc(nose.x, nose.y, 2.5, 0, 7); ctx.fill();
  }

  function drawFrame(frame, meta) {
    ctx.fillStyle = "#0B1615";
    ctx.fillRect(0, 0, W, H);
    const anchors = anchorsFor(meta, frame, W, H);
    if (meta.left) drawHand(frame.left, anchors.left, NEON.left);
    if (meta.right) drawHand(frame.right, anchors.right, NEON.right);
    if (meta.face) drawFace(frame.face, anchors.face, NEON.face);
  }

  function playFrames(frames, meta) {
    return new Promise((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i >= frames.length) { clearInterval(timer); resolve(); return; }
        drawFrame(frames[i], meta);
        i++;
      }, 60);
    });
  }

  async function playSentence(words, references, onWordStart) {
    const playable = words.filter(w => references[w] && references[w].length > 0);
    for (const word of playable) {
      const take = references[word][0];
      onWordStart?.(word, take.meta);
      await playFrames(take.frames, take.meta);
    }
    ctx.fillStyle = "#0B1615";
    ctx.fillRect(0, 0, W, H);
  }

  return { playSentence };
}
