// Kiki's avatar is animated: it blinks, the pupils follow the mouse, and while working it looks up to the top right (like the logo looking at the stars).
// Layers (all 256×256, coordinates are pixels in the avatar image):
//   qiqi-base.png    avatar with the insides of the eyes painted black, used as the base
//   qiqi.png         original image, showing only the insides of the eyes (elliptical clip); translating it moves the pupils
//   qiqi-closed.png  just the two eyes, filled in with the surrounding skin tone; overlaying it closes the eyes
// A blink is three frames: half-closed → fully closed → half-closed → open. It only toggles visibility, no SVG morph animation, so it's stable in Safari too.
const EYES = [
  { cx: 115.2, cy: 168.4, rx: 19.4, ry: 20.2 }, // left eye
  { cx: 186.6, cy: 158.3, rx: 14.0, ry: 18.6 }, // right eye (profile, a bit narrower)
];
const LOOK = 5; // max pixels the pupils can move
const INSET = 2.5; // shrink the pupil layer a little so the black outline doesn't move with it
const STROKE = 'fill="none" stroke="#111" stroke-width="3.2" stroke-linecap="round"';

let uid = 0;

/** Mount the animated avatar into el (replacing its contents), returns { think(on), blink() }. */
export function mountQiqi(el) {
  const id = `qe${++uid}`;
  // Lower edge of the eyelid when half-closed: a slightly downward-curving line, roughly above the middle of the eye
  const lidEdge = (e) => {
    const y = e.cy - e.ry * 0.2;
    return { y, d: `M${e.cx - e.rx * 1.05} ${y} Q${e.cx} ${y + e.ry * 0.45} ${e.cx + e.rx * 1.05} ${y}` };
  };
  const defs = EYES.map((e, i) => {
    const { y } = lidEdge(e);
    const top = e.cy - e.ry - 8, l = e.cx - e.rx - 8, r = e.cx + e.rx + 8;
    return `
      <clipPath id="${id}i${i}"><ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx - INSET}" ry="${e.ry - INSET}"/></clipPath>
      <clipPath id="${id}h${i}"><path d="M${l} ${top} H${r} V${y} Q${e.cx} ${y + e.ry * 0.9} ${l} ${y} Z"/></clipPath>`;
  }).join("");
  const irises = EYES.map((_, i) => `<g clip-path="url(#${id}i${i})"><image class="iris" href="/qiqi.png" width="256" height="256"/></g>`).join("");
  const half = EYES.map((e, i) => `<g clip-path="url(#${id}h${i})"><image href="/qiqi-closed.png" width="256" height="256"/></g><path d="${lidEdge(e).d}" ${STROKE}/>`).join("");
  // Fully closed: a downward-curving arc, like squinting
  const shut = EYES.map((e) => `<path d="M${e.cx - e.rx * 0.95} ${e.cy + e.ry * 0.05} Q${e.cx} ${e.cy + e.ry * 0.7} ${e.cx + e.rx * 0.95} ${e.cy + e.ry * 0.05}" ${STROKE}/>`).join("");
  el.innerHTML = `<svg class="qiqi-ava" viewBox="0 0 256 256" aria-hidden="true"><defs>${defs}</defs>
    <image href="/qiqi-base.png" width="256" height="256"/>${irises}
    <g class="half" display="none">${half}</g>
    <g class="shut" display="none"><image href="/qiqi-closed.png" width="256" height="256"/>${shut}</g></svg>`;
  const svg = el.firstElementChild;
  const iris = [...svg.querySelectorAll(".iris")];
  const halfG = svg.querySelector(".half"), shutG = svg.querySelector(".shut");

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let thinking = false, mouse = null, movedAt = 0, wander = [0, 0];
  const look = (x, y) => iris.forEach((im) => (im.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`));

  function aim() {
    if (thinking) return look(LOOK * 0.8, -LOOK * 0.8); // look up at the stars in the top right
    if (mouse && Date.now() - movedAt < 4000) {
      const r = svg.getBoundingClientRect();
      const dx = mouse[0] - (r.left + r.width * 0.6), dy = mouse[1] - (r.top + r.height * 0.64);
      const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 240) * LOOK;
      return look((dx / d) * k, (dy / d) * k);
    }
    look(wander[0], wander[1]);
  }

  const frame = (h, s) => { halfG.setAttribute("display", h ? "inline" : "none"); shutG.setAttribute("display", s ? "inline" : "none"); };
  function blink() {
    frame(1, 0);
    setTimeout(() => frame(0, 1), 45);
    setTimeout(() => frame(1, 0), 140);
    setTimeout(() => frame(0, 0), 185);
  }
  function blinkLoop() {
    // blink every 2.5–6 seconds, occasionally twice in a row; don't blink while the page is in the background
    setTimeout(() => {
      if (!document.hidden) { blink(); if (Math.random() < 0.2) setTimeout(blink, 300); }
      blinkLoop();
    }, 2500 + Math.random() * 3500);
  }
  function drift() {
    // when the mouse isn't moving, occasionally glance around on its own; most of the time look straight ahead
    setTimeout(() => {
      wander = Math.random() < 0.55 ? [0, 0] : [(Math.random() * 2 - 1) * LOOK, (Math.random() * 2 - 1) * LOOK * 0.6];
      aim();
      drift();
    }, 1800 + Math.random() * 2500);
  }

  if (!still) {
    blinkLoop();
    drift();
    addEventListener("pointermove", (e) => { mouse = [e.clientX, e.clientY]; movedAt = Date.now(); aim(); }, { passive: true });
  }
  return {
    think(on) { if (on !== thinking) { thinking = on; if (!still) aim(); } }, // with reduced motion, even "looking at the stars" doesn't move
    blink,
  };
}
