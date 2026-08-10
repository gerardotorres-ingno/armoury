#!/usr/bin/env node
/**
 * diff.mjs — Compara dos snapshots de extracción y genera el changelog.
 *
 *   node diff.mjs snapshots/2026-08-09 snapshots/2026-08-16
 *   node diff.mjs <anterior> <nuevo> --json
 *
 * Identidad: par (id, name). Permite distinguir cuatro casos que un solo
 * campo confunde:
 *   id igual  + nombre igual    → la misma unidad
 *   id igual  + nombre distinto → RENOMBRADA   (mapeo se conserva)
 *   id nuevo  + nombre igual    → RECREADA     (hay que reapuntar el mapeo)
 *   id nuevo  + nombre nuevo    → alta / baja real
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const asKey = (d) => `${d.id}|${d.name}`;

async function loadSnapshot(dir) {
  const files = (await fs.readdir(dir)).filter(
    (f) => f.endsWith('.json') && f !== '_index.json' && f !== '_changelog.json'
  );

  const byCatalogue = new Map();
  for (const f of files) {
    const d = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    // Sólo nativas: las aliadas ya se reportan en su propio catálogo.
    byCatalogue.set(d.catalogueName, {
      version: d.version,
      revision: d.revision,
      datasheets: d.datasheets.filter((x) => x.native),
    });
  }
  return byCatalogue;
}

function diffCatalogue(oldSheets, newSheets) {
  const byId = (arr) => new Map(arr.map((d) => [d.id, d]));
  const byName = (arr) => {
    const m = new Map();
    for (const d of arr) {
      if (!m.has(d.name)) m.set(d.name, []);
      m.get(d.name).push(d);
    }
    return m;
  };

  const oldById = byId(oldSheets);
  const newById = byId(newSheets);
  const oldByName = byName(oldSheets);
  const newByName = byName(newSheets);

  const events = [];
  const matchedOld = new Set();
  const matchedNew = new Set();

  // --- 1. Match por id (el caso normal) -----------------------------------
  for (const [id, nu] of newById) {
    const old = oldById.get(id);
    if (!old) continue;
    matchedOld.add(id);
    matchedNew.add(id);

    if (old.name !== nu.name) {
      events.push({ kind: 'renamed', from: old.name, to: nu.name, id });
    }
    if (old.mode !== nu.mode) {
      events.push({
        kind: `${old.mode}->${nu.mode}`,
        name: nu.name,
        id,
        from: old.mode,
        to: nu.mode,
      });
    }
    if (old.points !== nu.points) {
      events.push({
        kind: 'points',
        name: nu.name,
        id,
        from: old.points,
        to: nu.points,
      });
    }
  }

  // --- 2. Match por nombre entre los sobrantes → RECREADA ------------------
  for (const [id, nu] of newById) {
    if (matchedNew.has(id)) continue;
    const candidates = (oldByName.get(nu.name) ?? []).filter(
      (o) => !matchedOld.has(o.id)
    );
    if (candidates.length !== 1) continue;

    const old = candidates[0];
    matchedOld.add(old.id);
    matchedNew.add(id);

    // Esto es lo que hay que reapuntar en mini_type_mapping.
    events.push({ kind: 'recreated', name: nu.name, oldId: old.id, newId: id });

    if (old.mode !== nu.mode) {
      events.push({
        kind: `${old.mode}->${nu.mode}`,
        name: nu.name,
        id,
        from: old.mode,
        to: nu.mode,
      });
    }
    if (old.points !== nu.points) {
      events.push({ kind: 'points', name: nu.name, id, from: old.points, to: nu.points });
    }
  }

  // --- 3. Lo que quedó suelto es alta o baja real -------------------------
  for (const [id, nu] of newById) {
    if (!matchedNew.has(id)) {
      events.push({ kind: 'added', name: nu.name, id, mode: nu.mode, points: nu.points });
    }
  }
  for (const [id, old] of oldById) {
    if (!matchedOld.has(id)) {
      events.push({ kind: 'removed', name: old.name, id, mode: old.mode });
    }
  }

  return events;
}

// ---------------------------------------------------------------- salida

const LABEL = {
  added: '➕ Nueva',
  removed: '➖ Eliminada',
  renamed: '✏️  Renombrada',
  recreated: '🔁 Recreada (id nuevo)',
  'standard->legends': '⚠️  Pasa a Legends',
  'legends->standard': '✅ Sale de Legends',
  'standard->crucible': '📖 Pasa a Crucible',
  'crucible->standard': '✅ Sale de Crucible',
  'legends->crucible': '📖 Legends → Crucible',
  'crucible->legends': '⚠️  Crucible → Legends',
  points: '💰 Puntos',
};

const ORDER = [
  'standard->legends', 'legends->standard',
  'added', 'removed', 'renamed', 'recreated',
  'standard->crucible', 'crucible->standard',
  'legends->crucible', 'crucible->legends',
  'points',
];

function render(byCatalogue) {
  const lines = [];
  let totals = {};

  for (const [name, events] of byCatalogue) {
    if (!events.length) continue;
    lines.push(`\n### ${name}`);
    const grouped = new Map();
    for (const e of events) {
      if (!grouped.has(e.kind)) grouped.set(e.kind, []);
      grouped.get(e.kind).push(e);
      totals[e.kind] = (totals[e.kind] ?? 0) + 1;
    }
    for (const kind of ORDER) {
      const list = grouped.get(kind);
      if (!list) continue;
      for (const e of list) {
        if (kind === 'points') {
          lines.push(`- ${LABEL[kind]} · ${e.name}: ${e.from} → ${e.to}`);
        } else if (kind === 'renamed') {
          lines.push(`- ${LABEL[kind]} · ${e.from} → ${e.to}`);
        } else if (kind === 'recreated') {
          lines.push(`- ${LABEL[kind]} · ${e.name}`);
        } else {
          lines.push(`- ${LABEL[kind]} · ${e.name}`);
        }
      }
    }
  }

  return { lines, totals };
}

// ---------------------------------------------------------------- main

async function main() {
  const [oldDir, newDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const asJson = process.argv.includes('--json');

  if (!oldDir || !newDir) {
    console.error('uso: node diff.mjs <snapshot-anterior> <snapshot-nuevo> [--json]');
    process.exit(1);
  }

  const [prev, next] = await Promise.all([loadSnapshot(oldDir), loadSnapshot(newDir)]);

  const result = new Map();
  const allNames = new Set([...prev.keys(), ...next.keys()]);

  for (const name of [...allNames].sort()) {
    const o = prev.get(name);
    const n = next.get(name);

    if (!o) {
      result.set(name, [{ kind: 'added', name: '(catálogo nuevo)', id: null }]);
      continue;
    }
    if (!n) {
      result.set(name, [{ kind: 'removed', name: '(catálogo eliminado)', id: null }]);
      continue;
    }
    result.set(name, diffCatalogue(o.datasheets, n.datasheets));
  }

  if (asJson) {
    console.log(JSON.stringify(Object.fromEntries(result), null, 2));
    return;
  }

  const { lines, totals } = render(result);
  const stamp = [...next.values()][0]?.version?.sha ?? '?';

  console.log(`# Changelog 40k 11e — rev ${stamp}`);
  if (!lines.length) {
    console.log('\nSin cambios entre los dos snapshots.');
    return;
  }
  console.log(
    '\n' +
      ORDER.filter((k) => totals[k])
        .map((k) => `${LABEL[k]}: ${totals[k]}`)
        .join('  ·  ')
  );
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
