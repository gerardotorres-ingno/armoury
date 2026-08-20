#!/usr/bin/env node
/**
 * missions.mjs — Misiones primarias, secundarias y despliegues.
 *
 * Fuente: IRONBUILT-LLC/ironbuilt-data (CC BY-SA 4.0), dataset comunitario.
 * Mismo criterio que BSData y el MFM: la app NO transcribe documentos de GW,
 * lee repos que la comunidad mantiene y actualiza.
 *
 * La licencia obliga a atribuir y a compartir igual: la atribución va visible
 * en la app y queda anotada en el JSON generado.
 *
 * Salida: ./output-missions/missions.json
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const REPO = 'IRONBUILT-LLC/ironbuilt-data';
const DIR = './data-missions';
const SRC = path.join(DIR, 'ironbuilt-data-main', 'datasets');
const OUT = './output-missions';

// Los datasets vienen con BOM: hay que sacarlo antes de parsear.
const readJson = async (f) => JSON.parse((await fs.readFile(f, 'utf8')).replace(/^\uFEFF/, ''));

async function download() {
  await fs.mkdir(DIR, { recursive: true });
  const tar = path.join(DIR, 'src.tar.gz');
  console.log(`↓ Descargando ${REPO} ...`);
  const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tar));
  await fs.rm(path.join(DIR, 'ironbuilt-data-main'), { recursive: true, force: true });
  // Sólo los datasets: el repo lleva 15 MB de imágenes de mapas.
  await execFileP('tar', ['-xzf', tar, '-C', DIR,
    'ironbuilt-data-main/datasets', 'ironbuilt-data-main/LICENSE', 'ironbuilt-data-main/NOTICE']);
}

async function main() {
  if (!process.argv.includes('--no-download')) await download();

  const m = await readJson(path.join(SRC, 'wh40k-11e-missions.json'));
  let maps = null;
  try { maps = await readJson(path.join(SRC, 'wh40k-11e-maps.json')); } catch {}

  // --- primarias: matriz direccional [tuya][rival]
  const dispositions = m.primaries.dispositions;
  const matrix = {};
  for (const [mine, row] of Object.entries(m.primaries.matrix)) {
    matrix[mine] = {};
    for (const [theirs, cell] of Object.entries(row)) {
      matrix[mine][theirs] = {
        n: cell.mission,
        setup: cell.setup ?? null,
        action: cell.action ?? null,
        score: (cell.score ?? []).map((t) => ({
          w: t.when, max: t.max ?? null,
          i: (t.items ?? []).map((x) => [x.vp, x.text]),
        })),
      };
    }
  }

  // --- secundarias
  const cards = (m.secondaries.cards ?? []).map((c, idx) => ({
    id: 'ib' + idx,
    n: c.name,
    type: c.type,
    drawn: c.whenDrawn ?? null,
    tiers: (c.score ?? []).map((t) => ({
      mode: t.mode ?? null, w: t.when, max: t.max ?? null,
      i: (t.items ?? []).map((x) => [x.vp, x.text]),
    })),
  }));

  // Tope numérico por carta: el mayor VP que declara, para el contador.
  for (const c of cards) {
    const nums = c.tiers.flatMap((t) =>
      [t.max, ...t.i.map(([vp]) => vp)]
        .map((v) => parseInt(String(v).replace('+', ''), 10))
        .filter(Number.isFinite));
    c.max = nums.length ? Math.max(...nums) : 5;
  }

  /* Despliegues: 15 emparejamientos de disposiciones x 3 disposiciones de
   * terreno (A/B/C), con la imagen del mapa servida por el propio dataset.
   * Se guarda la URL, no la imagen: pesan y se cargan sólo si las mirás. */
  const layouts = (maps?.layouts ?? maps?.maps ?? []).map((l) => ({
    letter: l.layout ?? l.letter ?? null,
    a: l.attacker?.disposition ?? l.attacker ?? null,
    d: l.defender?.disposition ?? l.defender ?? null,
    am: l.attacker?.mission ?? null,
    dm: l.defender?.mission ?? null,
    img: l.image ?? l.imageUrl ?? null,
    page: l.page ?? null,
  })).filter((l) => l.letter && l.img);

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'missions.json'), JSON.stringify({
    version: m.version,
    source: REPO,
    licence: 'CC BY-SA 4.0',
    provenance: m.provenance,
    dispositions, matrix, cards, layouts,
  }));

  console.log(`✔ ${m.version}`);
  console.log(`  ${dispositions.length} disposiciones · ${Object.keys(matrix).length} filas de matriz · ` +
              `${cards.length} secundarias · ${layouts.length} despliegues`);
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
