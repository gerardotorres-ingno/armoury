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

async function grab(repo, tarName, folder, members) {
  const tar = path.join(DIR, tarName);
  console.log(`↓ Descargando ${repo} ...`);
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/refs/heads/main`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tar));
  await fs.rm(path.join(DIR, folder), { recursive: true, force: true });
  await execFileP('tar', ['-xzf', tar, '-C', DIR, ...members]);
}

async function download() {
  await fs.mkdir(DIR, { recursive: true });
  // Sólo los datasets: el repo de IRONBUILT lleva 15 MB de imágenes.
  await grab(REPO, 'src.tar.gz', 'ironbuilt-data-main', [
    'ironbuilt-data-main/datasets', 'ironbuilt-data-main/LICENSE', 'ironbuilt-data-main/NOTICE']);

  // Metadatos de referencia rápida. Opcional: si falla, la app sigue igual.
  try {
    await grab('tabletop-developer-consortium/40kdc-data', 'dc.tar.gz', '40kdc-data-main',
      ['40kdc-data-main/data/core/weapon-keywords.json',
       '40kdc-data-main/data/core/stratagems.json']);
  } catch (e) { console.warn('  (sin 40kdc-data:', e.message + ')'); }
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

  // ---- esqueleto de referencia rápida (40kdc-data) --------------------
  // Nombres y metadatos de palabras clave y estratagemas. NO traen texto:
  // el propio dataset los deja vacíos a propósito. Sirven como esqueleto
  // para que el usuario escriba una línea por entrada en vez de tipear
  // los 34 nombres a mano.
  let quickRef = [];
  try {
    const dcDir = path.join(DIR, '40kdc-data-main', 'data', 'core');
    const kw = await readJson(path.join(dcDir, 'weapon-keywords.json'));
    const st = await readJson(path.join(dcDir, 'stratagems.json'));

    quickRef = [
      ...kw.map((k) => ({
        sec: 'Weapon keywords', n: k.name,
        meta: (k.required_parameters || []).length ? 'takes a value' : '',
      })),
      ...st.filter((x) => x.category === 'core').map((x) => ({
        sec: 'Command', n: x.name,
        meta: [x.cp_cost != null ? x.cp_cost + ' CP' : '', x.type,
               (x.phases || []).join('/'), x.timing].filter(Boolean).join(' · '),
      })),
    ];
  } catch { /* opcional */ }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'missions.json'), JSON.stringify({
    quickRef,
    version: m.version,
    source: REPO,
    licence: 'CC BY-SA 4.0',
    provenance: m.provenance,
    dispositions, matrix, cards, layouts,
  }));

  console.log(`✔ ${m.version}`);
  console.log(`  ${dispositions.length} disposiciones · ${Object.keys(matrix).length} filas de matriz · ` +
              `${cards.length} secundarias · ${layouts.length} despliegues · ` +
              `${quickRef.length} entradas de referencia`);
}

main().catch((e) => { console.error('✖', e.message); process.exit(1); });
