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
    yield { type, time, frame, offset: start, next: at + skip, data: type === FrameType.CONSOLE ? buf.subarray(at, at + 64) : null };
    at += skip;
  }
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
