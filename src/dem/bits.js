// Bit writes in the order of the engine (MSG_WriteBits): least significant bit first. The inverse of BitReader.

export class BitWriter {
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
    this.pos = 0;
  }

  grow(bits) {
    const need = (this.pos + bits + 7) >> 3;
    if (need <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(need, this.buf.length * 2));
    this.buf.copy(next);
    this.buf = next;
  }

  /** The low `n` bits of a non-negative value (n up to 53). */
  write(value, n) {
    if (n === 0) return;
    this.grow(n);
    let v = value;
    while (n > 0) {
      const offset = this.pos & 7;
      const take = Math.min(8 - offset, n);
      const part = v % 2 ** take;
      this.buf[this.pos >> 3] |= part << offset;
      v = Math.floor(v / 2 ** take);
      n -= take;
      this.pos += take;
    }
  }

  bit(b) { this.write(b ? 1 : 0, 1); }

  /** A sign bit, then the magnitude in the other bits, clamped as MSG_WriteSBits does. */
  signed(value, n) {
    const max = 2 ** (n - 1) - 1;
    const magnitude = Math.min(Math.abs(value), max);
    this.write(value < 0 ? 1 : 0, 1);
    this.write(magnitude, n - 1);
  }

  /** A string of bytes and its zero. */
  string(bytes) {
    for (const c of bytes) this.write(c, 8);
    this.write(0, 8);
  }

  /** The written bytes, up to the last whole byte. */
  bytes() {
    return this.buf.subarray(0, (this.pos + 7) >> 3);
  }
}

/** Writes the low `n` bits of `value` over the bits of `buf` from bit `pos` (a field of fixed width). */
export function setBits(buf, pos, n, value) {
  for (let i = 0; i < n; i++) {
    const at = pos + i;
    const mask = 1 << (at & 7);
    if (Math.floor(value / 2 ** i) % 2) buf[at >> 3] |= mask;
    else buf[at >> 3] &= ~mask;
  }
}
