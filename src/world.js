// Follows the things in the world between samples: the weapon in each hand, purchases and pickups,
// thrown grenades, the bomb, and the weapons on the ground.

import { FREE, WEAPONS, weaponKey } from './shared/weapons.js';

// A weapon that first shows in a hand this long after a spawn, near the spawn point, was bought.
const BUY_SECONDS = 45;
const BUY_DISTANCE = 900;
// A jump this long between two samples is a respawn: the round restart moves every player.
const TELEPORT = 300;
const MOVETYPE_BOUNCE = 10;
// A thing on the ground that moves further than this between two samples is another thing.
const LEAP = 300;
const GRENADES = { hegrenade: 'he', flashbang: 'flash', smokegrenade: 'smoke' };

export class WorldTracker {
  constructor() {
    this.inHand = new Map();
    this.carried = new Map();
    this.spawns = new Map();
    this.last = new Map();
    this.roundStart = null;
    this.flying = new Map();
    this.lying = new Map();
    this.loadouts = [];
    this.purchases = [];
    this.grenades = [];
    this.bomb = [];
    this.ground = [];
  }

  startRound(t) {
    this.roundStart = t;
  }

  /**
   * One sample of the world.
   * @param {Map} entities the decoded entity state
   * @param {Map} models modelindex -> file name
   * @param {(entity: number) => {team: string, dead: boolean}|null} playerOf
   */
  sample(t, entities, models, playerOf) {
    const seen = new Set();
    for (const [entity, e] of entities) {
      const player = playerOf(entity);
      if (player) {
        this.player(t, entity, e, models, player);
        continue;
      }
      const model = models.get(e.modelindex);
      const key = weaponKey(model);
      if (!key) continue;
      seen.add(entity);
      const at = [Math.round(e['origin[0]'] ?? 0), Math.round(e['origin[1]'] ?? 0), Math.round(e['origin[2]'] ?? 0)];
      if (key in GRENADES && e.movetype === MOVETYPE_BOUNCE) this.grenade(t, entity, key, e.owner ?? null, at);
      else this.lies(t, entity, key, at);
    }
    for (const [entity, g] of this.flying) if (!seen.has(entity)) this.land(entity, g, t);
    for (const [entity, item] of this.lying) if (!seen.has(entity)) this.pickedUp(entity, item, t);
  }

  player(t, entity, e, models, player) {
    if (player.dead) {
      if (this.last.has(entity)) this.last.get(entity).dead = true;
      this.carried.delete(entity);
      this.inHand.delete(entity);
      return;
    }
    const x = e['origin[0]'] ?? 0;
    const y = e['origin[1]'] ?? 0;
    const last = this.last.get(entity);
    if (!last || last.dead || Math.hypot(x - last.x, y - last.y) > TELEPORT) this.spawns.set(entity, { t, x, y, first: !last });
    this.last.set(entity, { x, y, dead: false });
    const key = weaponKey(models.get(e.weaponmodel));
    if (!key || this.inHand.get(entity) === key) return;
    this.inHand.set(entity, key);
    this.loadouts.push([round2(t), entity, key]);

    const carried = this.carried.get(entity) ?? new Set();
    this.carried.set(entity, carried);
    if (carried.has(key) || FREE.has(key)) {
      carried.add(key);
      return;
    }
    carried.add(key);
    // At the first sight of a player the recording does not know what they carried before.
    const spawn = this.spawns.get(entity);
    if (spawn.first && t - spawn.t < 1) return;
    const bought = !spawn.first && t - spawn.t < BUY_SECONDS && Math.hypot(x - spawn.x, y - spawn.y) < BUY_DISTANCE;
    if (WEAPONS[key].cls === 'grenade') {
      // A grenade counts as bought only in the freeze time (before this round's RoundTime) or just after;
      // one drawn later was bought earlier, and nobody picks one up in CS 1.x.
      const freeze = this.roundStart === null || this.roundStart < spawn.t || t - this.roundStart < 3;
      if (!bought || !freeze) return;
    }
    this.purchases.push({
      t: round2(t), entity, item: key, kind: bought ? 'buy' : 'pickup', price: bought ? WEAPONS[key].price : 0,
      x: Math.round(x), y: Math.round(y),
    });
  }

  grenade(t, entity, key, owner, at) {
    const g = this.flying.get(entity);
    if (!g || g.key !== key) {
      if (g) this.land(entity, g, t);
      this.flying.set(entity, { key, owner, t0: round2(t), moved: t, path: [[round2(t), at[0], at[1], at[2]]] });
      return;
    }
    const last = g.path[g.path.length - 1];
    if (Math.hypot(at[0] - last[1], at[1] - last[2], at[2] - last[3]) > 2) {
      g.moved = t;
      g.path.push([round2(t), at[0], at[1], at[2]]);
    }
  }

  land(entity, g, t) {
    this.flying.delete(entity);
    const end = g.path[g.path.length - 1];
    const kind = GRENADES[g.key];
    // An HE and a flash go off as they vanish; a smoke starts when it stops and lasts until it vanishes.
    const burst = kind === 'smoke' ? round2(g.moved) : round2(t);
    this.grenades.push({ kind, owner: g.owner, t0: g.t0, burst, t1: round2(t), x: end[1], y: end[2], z: end[3], path: g.path });
  }

  lies(t, entity, key, at) {
    const item = this.lying.get(entity);
    const moved = item ? Math.hypot(at[0] - item.x, at[1] - item.y, at[2] - item.z) : 0;
    // The same thing on its way: a dropped weapon or the bomb flies from the hands and comes to rest. Its way
    // is kept as the grenades' is. A leap in one sample is another thing in the entity's place.
    if (item && item.key === key && moved <= LEAP) {
      if (moved > 1) {
        item.path.push([round2(t), at[0], at[1], at[2]]);
        Object.assign(item, { x: at[0], y: at[1], z: at[2] });
      }
      return;
    }
    if (item) this.pickedUp(entity, item, t);
    this.lying.set(entity, { key, t0: round2(t), x: at[0], y: at[1], z: at[2], path: [[round2(t), at[0], at[1], at[2]]] });
  }

  pickedUp(entity, item, t) {
    this.lying.delete(entity);
    if (t - item.t0 < 0.5) return;
    // Where it came to rest, and the way there where it flew: [[t, x, y, z]].
    const row = { t0: item.t0, t1: round2(t), x: item.x, y: item.y, z: item.z, ...(item.path.length > 1 ? { path: item.path } : {}) };
    if (item.key === 'c4') this.bomb.push({ kind: 'planted', ...row });
    else if (item.key === 'backpack') this.bomb.push({ kind: 'dropped', ...row });
    else this.ground.push({ item: item.key, ...row });
  }

  finish(t) {
    for (const [entity, g] of this.flying) this.land(entity, g, t);
    for (const [entity, item] of this.lying) this.pickedUp(entity, item, t);
    const byStart = (a, b) => a.t0 - b.t0;
    this.grenades.sort(byStart);
    this.bomb.sort(byStart);
    this.ground.sort(byStart);
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
