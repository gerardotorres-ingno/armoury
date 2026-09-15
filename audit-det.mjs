#!/usr/bin/env node
/**
 * audit-det.mjs — Busca habilidades que en realidad concede un DESTACAMENTO
 * y que el catálogo enlaza directo a las unidades.
 *
 * El caso que lo motivó: Brazen Fury figura en Eightbound, pero sólo la
 * tienen jugando Possessed Slaughterband. Si se muestra siempre, se le
 * atribuye a la unidad algo que no es suyo.
 *
 * Método: se recogen los nombres de reglas de toda entrada con coste
 * "Detachment Points", y se cruzan contra las habilidades extraídas.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const RAW = './data/wh40k-11e-main';
const OUT = './output';

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const costOf = (n, name) => {
  const c = asArray(n.costs).find((x) => x.name === name);
  return c ? Number(c.value) : 0;
};

// --- 1. nombres de reglas concedidas por destacamentos, en todo el juego
// Mapa POR FACCIÓN: una regla de un destacamento de Space Marines no dice
// nada sobre una habilidad homónima de Aeldari. Cruzar entre facciones
// producía falsos positivos (Lightning Assault, Feel No Pain).
const byFactionRules = new Map();   // catálogo -> Map(regla -> destacamentos)
const files = (await fs.readdir(RAW)).filter((f) => f.endsWith('.json'));

for (const f of files) {
  const j = JSON.parse(await fs.readFile(path.join(RAW, f), 'utf8'));
  const c = j.catalogue || j.gameSystem;
  if (!c) continue;

  const key = c.name || f;
  if (!byFactionRules.has(key)) byFactionRules.set(key, new Map());
  const ruleToDet = byFactionRules.get(key);

  const stack = [...asArray(c.sharedSelectionEntries), ...asArray(c.sharedSelectionEntryGroups)];
  while (stack.length) {
    const n = stack.pop();
    if (n.name && costOf(n, 'Detachment Points') > 0) {
      for (const r of [...asArray(n.rules), ...asArray(n.infoLinks), ...asArray(n.profiles)]) {
        if (!r.name) continue;
        if (!ruleToDet.has(r.name)) ruleToDet.set(r.name, new Set());
        ruleToDet.get(r.name).add(n.name);
      }
    }
    for (const e of asArray(n.selectionEntries)) stack.push(e);
    for (const g of asArray(n.selectionEntryGroups)) stack.push(g);
  }
}

console.log(`catálogos con reglas de destacamento: ${byFactionRules.size}`);

// --- 2. unidades que las llevan como habilidad propia
const hits = [];
const outFiles = (await fs.readdir(OUT)).filter((f) => f.endsWith('.json') && f !== '_index.json');

for (const f of outFiles) {
  const c = JSON.parse(await fs.readFile(path.join(OUT, f), 'utf8'));
  const ruleToDet = byFactionRules.get(c.catalogueName) || new Map();
  for (const u of c.datasheets) {
    if (!u.native || !u.abilities) continue;
    for (const a of u.abilities) {
      const dets = ruleToDet.get(a.n);
      if (dets) hits.push({
        faction: c.catalogueName.replace(/^(Imperium|Chaos|Xenos)\s*-\s*/, ''),
        unit: u.name, ability: a.n, from: [...dets],
      });
    }
  }
}

console.log(`unidades afectadas: ${hits.length}\n`);
const byFaction = new Map();
for (const h of hits) {
  if (!byFaction.has(h.faction)) byFaction.set(h.faction, []);
  byFaction.get(h.faction).push(h);
}
for (const [fa, list] of [...byFaction].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${fa} (${list.length})`);
  for (const h of list.slice(0, 6))
    console.log(`   ${h.unit.padEnd(28)} ${h.ability}  ←  ${h.from.join(' / ')}`);
  if (list.length > 6) console.log(`   …y ${list.length - 6} más`);
}
