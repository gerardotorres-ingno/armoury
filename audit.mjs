#!/usr/bin/env node
/**
 * audit.mjs — Revisa las 1322 unidades buscando síntomas de extracción rota.
 *
 * Los bugs del Defiler (opciones enlazadas que no se leían, perfiles de armas
 * faltantes, nombres que no cruzan) se encontraron mirando UNA unidad. Esto
 * los busca en todas.
 */
import fs from 'node:fs/promises';

const D = JSON.parse(await fs.readFile('./app/collection-data.json', 'utf8'));

const wkey = (n) => String(n).split(' - ')[0]
  .replace(/^[\u27a4\s]+/, '').toLowerCase()
  .replace(/^(two|three|four|2|3|4)\s+/, '')
  .replace(/[^a-z0-9 ]/g, '').trim().replace(/s$/, '');

const flags = {
  sinArmas:        [],  // unidad sin ningún perfil de arma
  sinStats:        [],  // sin perfil de unidad
  grupoUnaOpcion:  [],  // grupo "one" con una sola alternativa → no es elección
  opcionSinPerfil: [],  // opción de arma sin perfil correspondiente
  perfilHuerfano:  [],  // nunca pasa, control de la normalización
  sinPuntos:       [],  // sin precio en ninguna fuente
  sinMfm:          [],  // sin precio oficial del MFM
};

let total = 0;
for (const f of D.factions) {
  for (const u of f.units) {
    total++;
    const tag = f.name + ' :: ' + u.n;

    if (!u.w || !u.w.length) flags.sinArmas.push(tag);
    if (!u.st) flags.sinStats.push(tag);
    if (u.p == null && !u.B) flags.sinPuntos.push(tag);
    if (!u.B) flags.sinMfm.push(tag);

    const profKeys = new Set((u.w || []).map((w) => wkey(w[0])));

    for (const g of (u.o || [])) {
      if (g.k === 'one' && g.opts.length < 2)
        flags.grupoUnaOpcion.push(tag + ' → ' + g.n);

      // Sólo interesan los grupos que parecen de armamento: si ninguna de sus
      // opciones cruza con un perfil, probablemente no son armas (mejoras,
      // transportes) y no cuenta como error.
      const hits = g.opts.filter(([n]) => profKeys.has(wkey(n))).length;
      if (!hits) continue;
      for (const [n] of g.opts)
        if (!profKeys.has(wkey(n))) flags.opcionSinPerfil.push(tag + ' → ' + n);
    }
  }
}

const pct = (n) => (n / total * 100).toFixed(1) + '%';
console.log(`\n  ${total} unidades revisadas\n`);
const order = ['sinArmas','sinStats','sinPuntos','sinMfm','grupoUnaOpcion','opcionSinPerfil'];
const label = {
  sinArmas:'sin perfiles de arma', sinStats:'sin stats',
  sinPuntos:'sin puntos', sinMfm:'sin precio del MFM',
  grupoUnaOpcion:'grupos con una sola opción', opcionSinPerfil:'opciones sin perfil de arma',
};
for (const k of order) {
  const v = flags[k];
  console.log(String(v.length).padStart(5), label[k].padEnd(32), pct(v.length));
  for (const x of v.slice(0, 6)) console.log('        ', x);
  if (v.length > 6) console.log('         …y', v.length - 6, 'más');
}

if (process.argv.includes('--json'))
  await fs.writeFile('./audit.json', JSON.stringify(flags, null, 2));
