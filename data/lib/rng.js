// Tiny deterministic PRNG (mulberry32) plus the few helpers the data generators need.
// Same seed in, same numbers out, on every machine: the hospital and the messy CSV are reproducible.

export const DEFAULT_SEED = 20261003;

// Classic mulberry32: 32-bit state, returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Round to `dp` decimal places (avoids 0.30000000000000004 in the data).
export function round(value, dp = 1) {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function createRng(seed = DEFAULT_SEED) {
  const next = mulberry32(seed);
  const rng = {
    seed,
    next,
    // Integer in [min, max] (both inclusive).
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    // Float in [min, max), rounded to `dp` decimal places.
    float(min, max, dp = 2) {
      return round(min + next() * (max - min), dp);
    },
    // True with probability p.
    chance(p) {
      return next() < p;
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    // Weighted pick from [[value, weight], ...] or { value: weight }.
    weighted(entries) {
      const list = Array.isArray(entries) ? entries : Object.entries(entries);
      const total = list.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [value, w] of list) {
        r -= w;
        if (r < 0) return value;
      }
      return list[list.length - 1][0];
    },
    // Fisher-Yates, in place; returns the array.
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    // k distinct items (fewer if the array is shorter), in random order.
    sample(arr, k) {
      return rng.shuffle([...arr]).slice(0, k);
    },
  };
  return rng;
}

export default createRng;
