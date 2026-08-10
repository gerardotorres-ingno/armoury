#!/usr/bin/env node
/**
 * mfm.mjs — Descarga el Munitorum Field Manual scrapeado (BSData/wh40k-11e-mfm)
 * y produce ./output-mfm/mfm.json.
 *
 * Por qué existe: BSData modela el catálogo (qué unidades hay, keywords,
 * armas, reglas) pero su precio es incompleto. El MFM es la fuente oficial y
 * trae tres cosas que el catálogo no da:
 *
 *   1. UMBRALES DE REQUISICIÓN — repetir una unidad la encarece.
 *      Chaos Terminators: 165 las dos primeras, 175 de la tercera en adelante.
 *   2. MEJORAS POR DESTACAMENTO — con sus puntos. En BSData quedan sueltas
 *      en una bolsa por facción, sin saber cuál permite cada destacamento.
 *   3. TAMAÑOS DE UNIDAD exactos, en vez de deducirlos del salto de precio.
 *
 * Regla de precedencia: para PUNTOS manda el MFM. Para todo lo demás
 * (keywords, armas, habilidades, roles) manda BSData.
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';

const execFileP = promisify(execFile);
const REPO = 'BSData/wh40k-11e-mfm';
const DIR = './data-mfm';
const SRC = path.join(DIR, 'wh40k-11e-mfm-main', 'data');
const OUT = './output-mfm';

async function download() {
  await fs.mkdir(DIR, { recursive: true });
  const tarball = path.join(DIR, 'mfm.tar.gz');
  console.log(`↓ Descargando ${REPO} ...`);
  const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tarball));
  await fs.rm(path.join(DIR, 'wh40k-11e-mfm-main'), { recursive: true, force: true });
  await execFileP('tar', ['-xzf', tarball, '-C', DIR]);
}

/** "[1,2]" → {from:1,to:2} · "[3,)" → {from:3,to:null} */
function parseRange(r) {
  const m = /^\[(\d+),\s*(\d+)?\)?\]?$/.exec(String(r).replace(/\s/g, ''));
  if (!m) return { from: 1, to: null };
  return { from: Number(m[1]), to: m[2] ? Number(m[2]) : null };
}

async function main() {
  if (!process.argv.includes('--no-download')) await download();

  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.yaml') && f !== 'meta.yaml');
  const meta = YAML.parse(await fs.readFile(path.join(SRC, 'meta.yaml'), 'utf8'));

  const factions = [];
  let unitCount = 0, tierCount = 0, enhCount = 0;

  for (const file of files) {
    const d = YAML.parse(await fs.readFile(path.join(SRC, file), 'utf8'));

    const units = (d.units ?? []).map((u) => {
      // Cada bloque de pricing es un tramo de repetición con su propia escalera.
      const bands = (u.pricing ?? []).map((p) => {
        const { from, to } = parseRange(p.range);
        return {
          from, to,
          label: p.label ?? null,
          tiers: (p.costs ?? []).map((c) => ({ models: c.models, pts: c.points })),
        };
      });
      if (bands.length > 1) tierCount++;
      return { name: u.name, bands, leaderTo: u.leaderTo ?? null };
    });
    unitCount += units.length;

    const detachments = (d.detachments ?? []).map((x) => {
      enhCount += (x.enhancements ?? []).length;
      return {
        name: x.name,
        dp: x.dp ?? 0,
        objective: x.objective ?? null,
        // Etiqueta de exclusión: dos destacamentos con la misma no se combinan.
        unique: x.unique ?? null,
        enhancements: (x.enhancements ?? []).map((e) => ({
          name: e.name, pts: e.points, leaderTo: e.leaderTo ?? null,
        })),
      };
    });

    factions.push({ slug: d.slug, name: d.name, detachments, units });
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'mfm.json'),
    JSON.stringify({ version: meta.version, lastUpdated: meta.lastUpdated, factions }, null, 2));

  console.log(`✔ MFM v${meta.version} (${meta.lastUpdated})`);
  console.log(`  ${factions.length} facciones · ${unitCount} unidades · ${tierCount} con umbrales de requisición · ${enhCount} mejoras`);
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
