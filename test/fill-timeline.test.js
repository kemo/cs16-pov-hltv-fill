import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SVC } from '../src/goldsrc/messages.js';
import { buildTimeline, serverEye } from '../src/timeline.js';
import { povDemo } from './goldsrc-fixture.js';

const RADAR = 101;
const newUserMsg = (id, name) => {
  const msg = Buffer.alloc(19);
  msg.set([SVC.NEWUSERMSG, id, 0xff]);
  msg.write(name, 3, 'latin1');
  return msg;
};
const radar = (entity, x, y, z) => {
  const data = Buffer.alloc(7);
  data[0] = entity;
  [x, y, z].forEach((v, k) => data.writeInt16LE(v * 8, 1 + k * 2));
  return Buffer.concat([Buffer.from([RADAR, data.length]), data]);
};

test('a POV timeline holds the eye of the recorder at each change', () => {
  const tl = buildTimeline(povDemo({ count: 4, recorderAt: (i) => [Math.min(i, 2) * 10, 50, -20] }));
  assert.deepEqual(tl.eyes.map((e) => e.slice(1)), [[0, 50, -20], [10, 50, -20], [20, 50, -20]]);
  assert.deepEqual(tl.fires, []);
});

test('the eye of the server is the origin with the view offset, 18 lower for a ducking player', () => {
  const own = { 'origin[0]': 1, 'origin[1]': 2, 'origin[2]': 100, 'view_ofs[2]': 17 };
  assert.deepEqual(serverEye(own), [1, 2, 117]);
  assert.deepEqual(serverEye({ ...own, 'view_ofs[2]': 12, flags: 1 << 14 }), [1, 2, 94]);
  assert.equal(serverEye({}), null);
});

test('the radar of a teammate is a row of the POV timeline', () => {
  const tl = buildTimeline(povDemo({ count: 6, extra: (i) => (i === 0 ? [newUserMsg(RADAR, 'Radar')] : i === 3 ? [radar(2, -224, 1504, 113)] : []) }));
  assert.deepEqual(tl.radar, [[1.3, 2, -224, 1504, 113]]);
});

test('a body of CS 1.5 names no player: it is the open death of its side', () => {
  const death = Buffer.from([102, 7, 1, 2, ...Buffer.from('ak47\0')]);
  const body = Buffer.alloc(5 + 25);
  body.write('leet\0', 0, 'latin1');
  [640, -320, 36].forEach((v, k) => body.writeInt32LE(v * 128, 5 + k * 4));
  body.writeInt16LE(90 * 8, 5 + 14);
  body[5 + 22] = 101;
  body[5 + 24] = 2;
  const corpse = Buffer.concat([Buffer.from([103, body.length]), body]);
  const extra = (i) => (i === 0 ? [newUserMsg(102, 'DeathMsg'), newUserMsg(103, 'ClCorpse')] : i === 2 ? [death] : i === 4 ? [corpse] : []);
  const tl = buildTimeline(povDemo({ count: 6, extra }));
  assert.deepEqual(tl.corpses, [[1.4, 2, 640, -320, 36, 90, 101, 'leet', 'CT']]);
  // A body with no open death of its side is nobody's.
  assert.deepEqual(buildTimeline(povDemo({ count: 6, extra: (i) => (i === 0 ? [newUserMsg(103, 'ClCorpse')] : i === 4 ? [corpse] : []) })).corpses, []);
});
