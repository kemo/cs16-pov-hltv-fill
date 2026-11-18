// Writes a delta-compressed structure: the inverse of readDelta() of src/goldsrc/delta.js, with the field encodings
// of the engine (DELTA_WriteMarkedFields).

import { DT } from '../goldsrc/delta.js';

/**
 * The raw value that the engine writes for a field: an integer of the field's bits (a string stays bytes). A value
 * that readDelta() gave comes back as the same raw value. A missing value is zero, as readDelta() starts from zeros.
 */
export function rawOf(field, value) {
  const type = field.type & ~DT.SIGNED;
  if (type & DT.STRING) return value ?? Buffer.alloc(0);
  const v = value ?? 0;
  if (type & DT.ANGLE) {
    const steps = 2 ** field.bits;
    return ((Math.round(v * steps / 360) % steps) + steps) % steps;
  }
  if (type & DT.TIMEWINDOW_8) return Math.round(v * 100);
  if (type & DT.TIMEWINDOW_BIG) return Math.round(v * field.divisor);
  return Math.round((v / field.post) * field.divisor);
}

function sameRaw(a, b) {
  return Buffer.isBuffer(a) ? Buffer.isBuffer(b) && a.equals(b) : a === b;
}

function writeRaw(bw, field, raw) {
  const type = field.type & ~DT.SIGNED;
  if (type & DT.STRING) return bw.string(raw);
  if (type & DT.TIMEWINDOW_8) return bw.signed(raw, 8);
  if (type & DT.TIMEWINDOW_BIG || field.type & DT.SIGNED) return bw.signed(raw, field.bits);
  const steps = 2 ** field.bits;
  bw.write(((raw % steps) + steps) % steps, field.bits);
}

/** The indexes of the fields whose raw values differ between `from` (null: zeros) and `to`. */
export function changedFields(table, from, to) {
  const out = [];
  for (let i = 0; i < table.length; i++) {
    const field = table[i];
    if (!sameRaw(rawOf(field, from?.[field.name]), rawOf(field, to[field.name]))) out.push(i);
  }
  return out;
}

/** Writes `to` as a delta against `from`: the mask of the changed fields, then each of them. */
export function writeDelta(bw, table, from, to, changed = changedFields(table, from, to)) {
  const mask = [];
  for (const i of changed) {
    while (mask.length <= i >> 3) mask.push(0);
    mask[i >> 3] |= 1 << (i & 7);
  }
  bw.write(mask.length, 3);
  for (const byte of mask) bw.write(byte, 8);
  for (const i of changed) writeRaw(bw, table[i], rawOf(table[i], to[table[i].name]));
}
