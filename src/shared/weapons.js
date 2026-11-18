// The weapons and items of Counter-Strike 1.x: display name, class and the CS 1.5 price. Pure module.

export const WEAPONS = {
  ak47: { name: 'AK-47', cls: 'rifle', price: 2500 },
  m4a1: { name: 'M4A1', cls: 'rifle', price: 3100 },
  sg552: { name: 'SG 552', cls: 'rifle', price: 3500 },
  aug: { name: 'AUG', cls: 'rifle', price: 3500 },
  famas: { name: 'FAMAS', cls: 'rifle', price: 2250 },
  galil: { name: 'Galil', cls: 'rifle', price: 2000 },
  awp: { name: 'AWP', cls: 'sniper', price: 4750 },
  scout: { name: 'Scout', cls: 'sniper', price: 2750 },
  g3sg1: { name: 'G3/SG-1', cls: 'sniper', price: 5000 },
  sg550: { name: 'SG 550', cls: 'sniper', price: 4200 },
  mp5: { name: 'MP5', cls: 'smg', price: 1500 },
  p90: { name: 'P90', cls: 'smg', price: 2350 },
  ump45: { name: 'UMP45', cls: 'smg', price: 1700 },
  mac10: { name: 'MAC-10', cls: 'smg', price: 1400 },
  tmp: { name: 'TMP', cls: 'smg', price: 1250 },
  m3: { name: 'M3', cls: 'shotgun', price: 1700 },
  xm1014: { name: 'XM1014', cls: 'shotgun', price: 3000 },
  m249: { name: 'M249', cls: 'mg', price: 5750 },
  deagle: { name: 'Desert Eagle', cls: 'pistol', price: 650 },
  usp: { name: 'USP', cls: 'pistol', price: 500 },
  glock18: { name: 'Glock', cls: 'pistol', price: 400 },
  p228: { name: 'P228', cls: 'pistol', price: 600 },
  elite: { name: 'Dual Elites', cls: 'pistol', price: 800 },
  fiveseven: { name: 'Five-seveN', cls: 'pistol', price: 750 },
  hegrenade: { name: 'HE granata', cls: 'grenade', price: 300 },
  flashbang: { name: 'Flash', cls: 'grenade', price: 200 },
  smokegrenade: { name: 'Dimna', cls: 'grenade', price: 300 },
  knife: { name: 'Nož', cls: 'knife', price: 0 },
  c4: { name: 'C4', cls: 'bomb', price: 0 },
  backpack: { name: 'C4', cls: 'bomb', price: 0 },
  thighpack: { name: 'Kliješta', cls: 'kit', price: 200 },
  shield: { name: 'Štit', cls: 'shield', price: 2200 },
};

/** "models/p_ak47.mdl" -> "ak47"; null for a model that is no weapon. */
export function weaponKey(model) {
  const m = /models\/[pw]_([a-z0-9]+)\.mdl$/.exec(model ?? '');
  if (!m) return null;
  const key = m[1] === 'mp5navy' ? 'mp5' : m[1];
  return key in WEAPONS ? key : null;
}

/** Weapons every player gets for free, never counted as bought. */
export const FREE = new Set(['knife', 'glock18', 'usp', 'c4']);
