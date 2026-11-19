// Walks the frames of a GoldSrc demo (demo protocol 5) in file order.
// The directory at the end is not used: an unfinished recording has none (see gamers/src/Demo/DemoFile.php).

const HEADER_BYTES = 544;
// Demo info (436) and the seven netchan sequence numbers (28) before a network block.
const NETWORK_STATE_BYTES = 464;

export const FrameType = {
  NETWORK_START: 0,
  NETWORK: 1,
  SECTION_START: 2,
  CONSOLE: 3,
  CLIENT_DATA: 4,
  SECTION_END: 5,
  EVENT: 6,
  WEAPON_ANIM: 7,
  SOUND: 8,
  BUFFER: 9,
};

export function readHeader(buf) {
  if (buf.length < HEADER_BYTES || buf.toString('latin1', 0, 6) !== 'HLDEMO') {
    throw new Error('Not a GoldSrc demo.');
  }
  const text = (start, len) => {
    const field = buf.subarray(start, start + len);
    const end = field.indexOf(0);
    return field.toString('latin1', 0, end < 0 ? len : end);
  };
  return {
    demoProtocol: buf.readUInt32LE(8),
    netProtocol: buf.readUInt32LE(12),
    mapName: text(16, 260),
    gameDir: text(276, 260),
    mapChecksum: buf.readUInt32LE(536),
    directoryOffset: buf.readUInt32LE(540),
  };
}

/** The directory offset of a header when it lies inside the file, else null (an unfinished recording). */
export function directoryOf(header, buf) {
  return header.directoryOffset > HEADER_BYTES && header.directoryOffset <= buf.length ? header.directoryOffset : null;
}

/**
 * Yields every frame. A network frame carries `view` (the recorder's view) and `data` (the server messages).
 * The walk stops at the directory, or at the end of the file when the last frame is cut short. `end.at` gets the
 * byte where the walk stopped: before a valid directory, a frame's length was damaged.
 */
export function* frames(buf, header = readHeader(buf), end = {}) {
  const limit = directoryOf(header, buf) ?? buf.length;
  let at = HEADER_BYTES;
  end.at = at;
  for (const frame of walk(buf, limit)) {
    end.at = frame.next;
    yield frame;
  }
}

function* walk(buf, limit) {
  let at = HEADER_BYTES;

  while (at + 9 <= limit) {
    const type = buf.readUInt8(at);
    const time = buf.readFloatLE(at + 1);
    const frame = buf.readUInt32LE(at + 5);
    const start = at;
    at += 9;

    if (type === FrameType.NETWORK_START || type === FrameType.NETWORK) {
      if (at + NETWORK_STATE_BYTES + 4 > limit) return;
      const view = readView(buf, at);
      const sequence = buf.readInt32LE(at + 436);
      at += NETWORK_STATE_BYTES;
      const length = buf.readUInt32LE(at);
      at += 4;
      if (at + length > limit) return;
      yield { type, time, frame, offset: start, next: at + length, view, sequence, data: buf.subarray(at, at + length) };
      at += length;
      continue;
    }

    let skip;
    switch (type) {
      case FrameType.SECTION_START:
      case FrameType.SECTION_END:
        skip = 0; break;
      case FrameType.CONSOLE: skip = 64; break;
      case FrameType.CLIENT_DATA: skip = 32; break;
      case FrameType.EVENT: skip = 84; break;
      case FrameType.WEAPON_ANIM: skip = 8; break;
      case FrameType.SOUND: {
        if (at + 8 > limit) return;
        skip = 8 + buf.readUInt32LE(at + 4) + 16;
        break;
      }
      case FrameType.BUFFER: {
        if (at + 4 > limit) return;
        skip = 4 + buf.readUInt32LE(at);
        break;
      }
      default:
        throw new Error(`Unknown frame type ${type} at byte ${start}.`);
    }
    if (at + skip > limit) return;
    yield {
      type, time, frame, offset: start, next: at + skip,
      data: type === FrameType.CONSOLE ? buf.subarray(at, at + 64) : null,
      ...(type === FrameType.EVENT ? { event: readEvent(buf, at) } : {}),
    };
    at += skip;
  }
}

// The fields of event_args_t after flags and entindex, in file order: 4 bytes each.
const EVENT_FIELDS = ['origin[0]', 'origin[1]', 'origin[2]', 'angles[0]', 'angles[1]', 'angles[2]',
  'velocity[0]', 'velocity[1]', 'velocity[2]', 'ducking', 'fparam1', 'fparam2', 'iparam1', 'iparam2', 'bparam1', 'bparam2'];
const EVENT_INTS = new Set(['ducking', 'iparam1', 'iparam2', 'bparam1', 'bparam2']);

/**
 * An event that the recorder's client played itself (its own predicted shots): the server does not send these to
 * their player, so a POV demo holds them only here. Same shape as a network event of src/goldsrc/messages.js.
 */
function readEvent(buf, at) {
  const args = { flags: buf.readInt32LE(at + 12), entindex: buf.readInt32LE(at + 16) };
  EVENT_FIELDS.forEach((name, i) => {
    const o = at + 20 + i * 4;
    args[name] = EVENT_INTS.has(name) ? buf.readInt32LE(o) : buf.readFloatLE(o);
  });
  return { index: buf.readInt32LE(at + 4), delay: buf.readFloatLE(at + 8), entity: args.entindex || null, args };
}

/** The recorder's own view from the fixed demo info: origin, angles and slot. */
function readView(buf, at) {
  const f = (o) => buf.readFloatLE(at + o);
  return {
    origin: [f(4), f(8), f(12)],
    angles: [f(16), f(20), f(24)],
    simOrigin: [f(104), f(108), f(112)],
    spectator: buf.readInt32LE(at + 80),
    health: buf.readInt32LE(at + 144),
    viewEntity: buf.readInt32LE(at + 180),
    playerNum: buf.readInt32LE(at + 184),
  };
}
