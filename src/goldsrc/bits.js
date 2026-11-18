// Byte and bit reads over one message block. Bits run least significant first, as the engine writes them.

export class Reader {
  constructor(buf, at = 0) {
    this.buf = buf;
    this.at = at;
  }

  get done() { return this.at >= this.buf.length; }

  need(n) {
    if (this.at + n > this.buf.length) throw new RangeError(`Read of ${n} bytes past the block end at ${this.at}.`);
  }

  u8() { this.need(1); return this.buf[this.at++]; }
  i8() { this.need(1); return this.buf.readInt8(this.at++); }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.at); this.at += 2; return v; }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.at); this.at += 2; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.at); this.at += 4; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.at); this.at += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.at); this.at += 4; return v; }
  skip(n) { this.need(n); this.at += n; }
  bytes(n) { this.need(n); const v = this.buf.subarray(this.at, this.at + n); this.at += n; return v; }
  coord() { return this.i16() / 8; }

  string() {
    const end = this.buf.indexOf(0, this.at);
    if (end < 0) throw new RangeError(`Unterminated string at ${this.at}.`);
    const v = this.buf.subarray(this.at, end);
    this.at = end + 1;
    return v;
  }

  /** Bit reads from the current byte; `end()` moves to the next whole byte. */
  bits() { return new BitReader(this); }
}

export class BitReader {
  constructor(reader) {
    this.reader = reader;
    this.buf = reader.buf;
    this.pos = reader.at * 8;
  }

  read(n) {
    if (n === 0) return 0;
    if (this.pos + n > this.buf.length * 8) throw new RangeError(`Bit read of ${n} past the block end at bit ${this.pos}.`);
    let value = 0;
    let shift = 0;
    while (n > 0) {
      const byte = this.buf[this.pos >> 3];
      const offset = this.pos & 7;
      const take = Math.min(8 - offset, n);
      value += ((byte >> offset) & ((1 << take) - 1)) * 2 ** shift;
      shift += take;
      n -= take;
      this.pos += take;
    }
    return value;
  }

  bit() { return this.read(1); }

  /** A sign bit, then the magnitude in the other bits. */
  signed(n) {
    const sign = this.read(1);
    const v = this.read(n - 1);
    return sign ? -v : v;
  }

  string() {
    const out = [];
    for (;;) {
      const c = this.read(8);
      if (c === 0) break;
      out.push(c);
      if (out.length > 4096) throw new RangeError('Bit string too long.');
    }
    return Buffer.from(out);
  }

  coord() {
    const intFlag = this.read(1);
    const fracFlag = this.read(1);
    if (!intFlag && !fracFlag) return 0;
    const sign = this.read(1);
    const whole = intFlag ? this.read(12) : 0;
    const frac = fracFlag ? this.read(3) : 0;
    const v = whole + frac / 8;
    return sign ? -v : v;
  }

  vec3Coord() {
    const flags = [this.read(1), this.read(1), this.read(1)];
    return flags.map((f) => (f ? this.coord() : 0));
  }

  end() {
    this.reader.at = (this.pos + 7) >> 3;
  }
}
