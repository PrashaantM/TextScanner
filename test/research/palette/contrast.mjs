// contrast.mjs: WCAG 2.1 contrast arithmetic for the single-scheme palette.
//
// NOT A GATE, deliberately - it is a measurement, and this repo's rule is that
// a measurement which does not gate anything lives under test/research/ rather
// than in test/ where the CI wiring check would expect a `run:` line for it.
//
// Why it exists. The theme system was removed in favour of one fixed scheme,
// which means there is no longer a light mode to fall back to when a surface
// sits over something bright. Several of this app's surfaces are glass - a
// translucent fill over a backdrop-filter - and the backdrop is the USER'S OWN
// PHOTOGRAPH, which can be anything from a white page scan to a night shot.
// Eyeballing that is how you ship a palette that is fine on the four images you
// happened to open. So: composite the alpha, then compute the ratio.
//
// Usage: node test/research/palette/contrast.mjs

export function hex(s) {
  const h = s.trim().replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

// sRGB -> relative luminance, WCAG 2.1 §relativeluminancedef.
export function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratio(fg, bg) {
  const a = luminance(Array.isArray(fg) ? fg : hex(fg));
  const b = luminance(Array.isArray(bg) ? bg : hex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Source-over composite of a translucent fill onto an opaque backdrop. This is
// what `background: rgba(...)` plus `backdrop-filter: blur()` actually resolves
// to for contrast purposes: the blur redistributes the backdrop's pixels but
// preserves their mean, so the mean is what the text has to survive.
export function over(fill, alpha, backdrop) {
  const f = Array.isArray(fill) ? fill : hex(fill);
  const b = Array.isArray(backdrop) ? backdrop : hex(backdrop);
  return f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
}

export const toHex = (rgb) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
export const fmt = (n) => n.toFixed(2);
