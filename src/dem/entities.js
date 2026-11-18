// Writes svc_packetentities and svc_deltapacketentities: the inverse of packetEntities() of src/goldsrc/messages.js,
// with the headers of the engine (SV_WriteDeltaHeader of ReHLDS).

import { SVC } from '../goldsrc/messages.js';
import { BitWriter } from './bits.js';
import { changedFields, writeDelta } from './delta.js';

function tableOf(state, number, custom) {
  if (custom) return state.deltas.get('custom_entity_state_t');
  return state.deltas.get(number > 0 && number <= state.maxClients ? 'entity_state_player_t' : 'entity_state_t');
}

/** The indexes of `changed` and of the fields named in `sent`, in the order of the table. */
function withSent(table, changed, sent) {
  const names = new Set(sent);
  const all = new Set(changed);
  table.forEach((field, i) => { if (names.has(field.name)) all.add(i); });
  return [...all].sort((a, b) => a - b);
}

/**
 * The bytes of one packet entities message that gives the client the entities `to` (a Map of number to state, with
 * `customs`, the numbers of the custom entities). With `from` (the client's entities of the frame `fromSequence`)
 * it is a delta message: an entity that did not change is left out, one that is gone is removed. Without it, every
 * entity is written against its baseline. No entity uses an instanced baseline or a baseline offset.
 */
export function writePacketEntities(state, to, { from = null, fromSequence = 0 } = {}) {
  const delta = from !== null;
  const bw = new BitWriter(1024);
  bw.write(delta ? SVC.DELTAPACKETENTITIES : SVC.PACKETENTITIES, 8);
  bw.write(to.size, 16);
  if (delta) bw.write(fromSequence & 0xff, 8);
  const numbers = [...new Set([...to.keys(), ...(delta ? from.keys() : [])])].sort((a, b) => a - b);
  let base = 0;
  const header = (number, remove, custom) => {
    const step = number - base;
    if (!delta && step === 1) {
      bw.write(1, 1);
    } else {
      bw.write(delta && remove ? 1 : 0, 1);
      if (step <= 0 || step >= 64) {
        bw.write(1, 1);
        bw.write(number, 11);
      } else {
        bw.write(0, 1);
        bw.write(step, 6);
      }
    }
    base = number;
    if (remove) return;
    bw.bit(custom);
    if (state.instancedBaselines.length > 0) bw.write(0, 1);
    if (!delta) bw.write(0, 1);
  };
  for (const number of numbers) {
    const next = to.get(number);
    const custom = to.customs?.has(number) ?? false;
    if (!next) {
      header(number, true, false);
      continue;
    }
    const table = tableOf(state, number, custom);
    // An entity that the client has keeps its state as the base; a new one starts from its baseline.
    const old = delta ? from.get(number) : undefined;
    const start = old ?? state.baselines.get(number) ?? null;
    // A field that the demo sent goes again even when its value is equal: a time window is new on each send.
    const sent = to.sent?.get(number);
    const changed = sent ? withSent(table, changedFields(table, start, next), sent) : changedFields(table, start, next);
    if (old !== undefined && changed.length === 0 && !sent) continue;
    header(number, false, custom);
    writeDelta(bw, table, start, next, changed);
  }
  bw.write(0, 16);
  return Buffer.from(bw.bytes());
}
