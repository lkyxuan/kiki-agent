// Default avatar for a bot: the little ball from the Kiki logo looking up and to the right, colored by name (the same name always gets the same color).
// Same system as the logo and app icon: a ball + two vertical eyes offset toward the upper right, every bot looking the same direction.
// Only two colors: one for the ball + white eyes. Usage: kikiBot("Life bot") → SVG string, transparent background.
(function () {
  // The first is the logo's indigo; the rest are picked at similar saturation so the white eyes stay clear on all of them
  const HUES = ["#5b6cf0", "#1f8bff", "#13b5c8", "#22b573", "#ffb300", "#ff7a1a", "#ff4f8b", "#d24fe0", "#8b5cf6", "#f0473c"];

  // name → color (FNV-1a hash)
  function hue(seed) {
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; // scramble so names sharing a suffix like "X bot" don't all cluster on one color
    return HUES[(h >>> 0) % HUES.length];
  }

  // Geometry copied from docs/assets/logo.svg (in the 1024 canvas: center 482,542 radius 290; eyes are 64×146 rounded bars,
  // top-left corners at 474,396 and 606,396), scaled proportionally to 32×32, ball radius 14, centered
  const S = 14 / 290, X = (v) => (16 + (v - 482) * S).toFixed(2), Y = (v) => (16 + (v - 542) * S).toFixed(2);
  const W = (64 * S).toFixed(2), H = (146 * S).toFixed(2), R = (32 * S).toFixed(2);
  const EYES = `<rect x="${X(474)}" y="${Y(396)}" width="${W}" height="${H}" rx="${R}"/><rect x="${X(606)}" y="${Y(396)}" width="${W}" height="${H}" rx="${R}"/>`;

  function kikiBot(seed) {
    return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
      + `<circle cx="16" cy="16" r="14" fill="${hue(seed || "bot")}"/><g fill="#fff">${EYES}</g></svg>`;
  }
  window.kikiBot = kikiBot;
})();
