// Delta-compressed structures. The server declares each structure's fields with svc_deltadescription,
// itself encoded with the fixed meta description below.

export const DT = {
  BYTE: 1,
  SHORT: 2,
  FLOAT: 4,
  INTEGER: 8,
  ANGLE: 16,
  TIMEWINDOW_8: 32,
  TIMEWINDOW_BIG: 64,
  STRING: 128,
  SIGNED: 0x80000000,
};

const META = [
  { name: 'fieldType', type: DT.INTEGER, bits: 32, divisor: 1, post: 1 },
  { name: 'fieldName', type: DT.STRING, bits: 1, divisor: 1, post: 1 },
  { name: 'fieldOffset', type: DT.INTEGER, bits: 16, divisor: 1, post: 1 },
  { name: 'fieldSize', type: DT.INTEGER, bits: 8, divisor: 1, post: 1 },
  { name: 'significant_bits', type: DT.INTEGER, bits: 8, divisor: 1, post: 1 },
  { name: 'premultiply', type: DT.FLOAT, bits: 32, divisor: 4000, post: 1 },
  { name: 'postmultiply', type: DT.FLOAT, bits: 32, divisor: 4000, post: 1 },
];

export class DeltaTables {
  constructor() {
    this.tables = new Map([['delta_description_t', META]]);
  }

  get(name) {
    const table = this.tables.get(name);
    if (!table) throw new Error(`No delta description for ${name}.`);
    return table;
  }

  has(name) { return this.tables.has(name); }

  /** svc_deltadescription: a name, a field count, then each field as a meta delta. */
  define(name, fields) {
    this.tables.set(name, fields.map((f) => ({
      name: f.fieldName?.toString('latin1') ?? '',
      type: f.fieldType ?? 0,
      bits: f.significant_bits ?? 0,
      divisor: f.premultiply || 1,
      post: f.postmultiply || 1,
    })));
  }
}

/** Reads one delta against `from` and returns a new object. `sent` (an array) gets the names of the fields read. */
export function readDelta(br, table, from = null, sent = null) {
  const to = from ? { ...from } : {};
  const maskBytes = br.read(3);
  const mask = [];
  for (let i = 0; i < maskBytes; i++) mask.push(br.read(8));

  for (let i = 0; i < table.length; i++) {
    if (!((mask[i >> 3] ?? 0) & (1 << (i & 7)))) continue;
    const field = table[i];
    const type = field.type & ~DT.SIGNED;
    const signed = (field.type & DT.SIGNED) !== 0;
    let value;
    if (type & DT.STRING) {
      value = br.string();
    } else if (type & DT.ANGLE) {
      value = br.read(field.bits) * (360 / 2 ** field.bits);
    } else if (type & DT.TIMEWINDOW_8) {
      value = br.signed(8) / 100;
    } else if (type & DT.TIMEWINDOW_BIG) {
      value = br.signed(field.bits) / field.divisor;
    } else if (type & (DT.BYTE | DT.SHORT | DT.INTEGER | DT.FLOAT)) {
      const raw = signed ? br.signed(field.bits) : br.read(field.bits);
      value = (raw / field.divisor) * field.post;
    } else {
      throw new Error(`Delta field ${field.name} has unknown type ${field.type}.`);
    }
    to[field.name] = value;
    sent?.push(field.name);
  }
  return to;
}
