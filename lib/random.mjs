export function randomUUID() {
  return globalThis.crypto.randomUUID();
}

export function randomInt(min, max) {
  if (max === undefined) { max = min; min = 0; }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new TypeError("Random bounds must be safe integers.");
  const range = max - min;
  if (range <= 0 || range >= 2 ** 48) throw new RangeError("Random range must be positive and less than 2^48.");
  const words = new Uint32Array(range <= 2 ** 32 ? 1 : 2);
  const span = words.length === 1 ? 2 ** 32 : 2 ** 48;
  const limit = span - (span % range);
  let value;
  do {
    globalThis.crypto.getRandomValues(words);
    value = words.length === 1 ? words[0] : (words[0] & 0xffff) * 2 ** 32 + words[1];
  } while (value >= limit);
  return min + (value % range);
}
