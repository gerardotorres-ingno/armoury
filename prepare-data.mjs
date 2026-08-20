#!/usr/bin/env node
/**
 * prepare-data.mjs — Convierte ./output/*.json en UN solo archivo que la app carga.
 *
 *   node prepare-data.mjs
 *   → app/collection-data.json
 *
 * Por qué existe: extract.mjs guarda todo (perfiles, keywords, aliadas) porque
 * eso sirve para el diff. La app de colección sólo necesita id, nombre, modo y
 * puntos. Compactarlo baja de ~1.5 MB a ~120 KB, que es lo que se descarga en
 * el celular.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = './output';
const APP_DIR = './app';

/* Topes de aliados declarados en el game system, comunes a todas las
 * facciones. Se leen del catálogo raíz de la 11ª edición. */
let GLOBAL_ALLY_CAPS = [];
try {
  const root = JSON.parse(await fs.readFile(
    path.join(OUT_DIR, 'warhammer-40-000-11th-edition.json'), 'utf8'));
  GLOBAL_ALLY_CAPS = (root.allyCaps ?? []).filter((a) => a.name !== 'Army Roster');
  console.log(`  Topes de aliados globales: ${GLOBAL_ALLY_CAPS.map((a) => a.name).join(', ')}`);
} catch {}

const files = (await fs.readdir(OUT_DIR)).filter(
  (f) => f.endsWith('.json') && f !== '_index.json'
);

/* Misiones: dataset comunitario IRONBUILT (CC BY-SA 4.0). Opcional —
 * sin él, la app usa la tabla mínima de nombres y la biblioteca manual. */
let MISSIONS = null;
try {
  MISSIONS = JSON.parse(await fs.readFile('./output-missions/missions.json', 'utf8'));
  console.log(`  Misiones ${MISSIONS.version} (${MISSIONS.cards.length} secundarias) cargadas`);
} catch {
  console.log('  Sin misiones (corré `node missions.mjs`)');
}

/* ------------------------------------------------------------------
 * MFM — la fuente oficial de puntos.
 *
 * Precedencia: para PUNTOS manda el MFM (trae umbrales de requisición,
 * tamaños exactos y mejoras por destacamento). Para el resto —keywords,
 * armas, habilidades, roles— manda BSData.
 *
 * Si no se corrió `node mfm.mjs`, sigue funcionando con lo de BSData.
 * ---------------------------------------------------------------- */
let MFM = null;
try {
  MFM = JSON.parse(await fs.readFile('./output-mfm/mfm.json', 'utf8'));
  console.log(`  MFM v${MFM.version} (${MFM.lastUpdated}) cargado`);
} catch {
  console.log('  Sin MFM (corré `node mfm.mjs` para precios oficiales)');
}

// Los nombres difieren en los prefijos: "Imperium - Adeptus Astartes -
// Space Marines" contra "Space Marines". Se normaliza y se compara.
const normF = (x) => x.toLowerCase()
  .replace(/^(imperium|chaos|xenos)\s*-\s*/, '')
  .replace(/adeptus astartes\s*-\s*/, '')
  .replace(/[^a-z0-9]/g, '');
const normU = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');

const mfmByFaction = new Map((MFM?.factions ?? []).map((f) => [normF(f.name), f]));

/* Índice global de armamento con coste, por nombre de unidad.
 *
 * El MFM lista las unidades por capítulo (Blood Angels :: Redemptor
 * Dreadnought) pero la app las guarda una sola vez, en el catálogo base de
 * Space Marines. Sin este respaldo, 25 unidades quedaban sin el precio.
 *
 * Sólo se usa para el ARMAMENTO, que cuesta lo mismo en todos los capítulos.
 * Los puntos de la unidad NO se toman de acá: esos sí varían. */
const mfmWargear = new Map();
for (const f of (MFM?.factions ?? []))
  for (const u of f.units)
    if (u.wargear?.length && !mfmWargear.has(normU(u.name)))
      mfmWargear.set(normU(u.name), u.wargear);

/* ------------------------------------------------------------------
 * ROLES — dos ejes cruzados: CHASIS × RANGO.
 *
 * No es una lista de precedencia plana. Una unidad tiene un chasis
 * (Infantry, Monster, Vehicle...) y opcionalmente un rango (Epic Hero,
 * Character, Battleline). Se combinan: "Monster Epic Hero", "Mounted
 * Character". Aplastarlo a una sola dimensión pierde información que
 * el jugador usa para armar listas.
 *
 * Verificado contra el dato: Angron = Monster+Character+Epic Hero,
 * Khârn = Infantry+Character+Epic Hero, Lord Invocatus = Mounted+…
 *
 * Dos distinciones que parecen redundantes y no lo son:
 *   Walker vs Vehicle              — Defiler y Helbrute son Walker.
 *   Transport vs Dedicated Transport — el Land Raider lleva pasajeros
 *     (Transport) pero no ocupa la ranura de transporte dedicado; el
 *     Rhino sí. Son 114 contra 36 unidades.
 * ---------------------------------------------------------------- */

// Chasis: gana el primero que coincida. El orden importa — Titanic
// antes que Vehicle, porque el Khorne Lord of Skulls es las dos cosas.
const CHASSIS = [
  ['titanic',  'Titanic',        'Titanic',      ['Titanic']],
  ['aircraft', 'Aircraft',       'Aircraft',     ['Aircraft']],
  ['walker',   'Walker',         'Walkers',      ['Walker']],
  ['vehicle',  'Vehicle',        'Vehicles',     ['Vehicle']],
  ['monster',  'Monster',        'Monsters',     ['Monster']],
  ['beast',    'Beast',          'Beasts',       ['Beast']],
  ['swarm',    'Swarm',          'Swarms',       ['Swarm']],
  ['mounted',  'Mounted',        'Mounted',      ['Mounted']],
  ['infantry', 'Infantry',       'Infantry',     ['Infantry']],
  ['fort',     'Fortification',  'Fortifications',['Fortification']],
  ['other',    'Other',          'Other',        []],
];

// Rangos, de mayor a menor.
const RANKS = [
  ['epic',      'Epic Heroes',  ['Epic Hero']],
  ['character', 'Characters',   ['Character']],
  ['battle',    'Battleline',   ['Battleline']],
];

// Orden en que se muestran los grupos sin rango.
const CHASSIS_DISPLAY = [
  'infantry','mounted','beast','swarm','monster',
  'walker','vehicle','aircraft','titanic','fort','other',
];

function classify(keywords) {
  const s = new Set(keywords);

  // El transporte dedicado ocupa su propia ranura: va aparte de todo.
  if (s.has('Dedicated Transport')) {
    return { id: 'dedicated', label: 'Dedicated Transports', order: 320 };
  }

  const chassis = CHASSIS.find(([, , , keys]) => keys.some((k) => s.has(k))) ?? CHASSIS.at(-1);
  const rank    = RANKS.find(([, , keys]) => keys.some((k) => s.has(k)));

  const [cid, cSing, cPlur] = chassis;

  if (rank) {
    const [rid, rLabel] = rank;
    // Battleline no se cruza con el chasis: el jugador cuenta "cuánta
    // línea tengo", no "cuánta línea de infantería".
    if (rid === 'battle') return { id: 'battle', label: 'Battleline', order: 300 };

    const rankIdx = rid === 'epic' ? 0 : 1;
    const cIdx = CHASSIS_DISPLAY.indexOf(cid);
    return {
      id: rid + ':' + cid,
      label: cSing + ' ' + rLabel,
      order: rankIdx * 100 + cIdx,
    };
  }

  // Vehículo con capacidad de transporte pero sin ranura dedicada.
  if (s.has('Transport')) {
    return { id: 'transport', label: 'Transports', order: 310 };
  }

  return { id: cid, label: cPlur, order: 400 + CHASSIS_DISPLAY.indexOf(cid) };
}

const roleTable = new Map();   // id -> { id, label, order }

function roleOf(keywords) {
  const r = classify(keywords);
  if (!roleTable.has(r.id)) roleTable.set(r.id, r);
  return r.id;
}

const factions = [];

for (const file of files) {
  const d = JSON.parse(await fs.readFile(path.join(OUT_DIR, file), 'utf8'));

  // Sólo nativas. Las aliadas se muestran desde SU propia facción: si un
  // jugador tiene Guardia Imperial, la carga en Astra Militarum, no dentro
  // de Genestealer Cults.
  // Facciones distintas de la nativa presentes en el catálogo: son las que
  // pueden aparecer como aliadas.
  const usedFactions = new Set(
    d.datasheets.filter((x) => x.faction && x.faction !== d.nativeFaction).map((x) => x.faction)
  );

  let factionExtras = null;
  // Nativas MÁS las facciones aliadas con tope declarado. Bloodletters y
  // compañía viven sólo dentro del catálogo de World Eaters con facción
  // "Blood Legions": el filtro de nativas las borraba del mapa, aunque son
  // parte legítima del ejército hasta cierto gasto.
  // Los topes globales (Legiones Daemonica, Astra Militarum, Tyranids…) están
  // declarados en el game system, no en cada facción. Se combinan con los
  // propios y después se filtran por lo que cada catálogo realmente usa.
  const caps = new Map();
  for (const a of GLOBAL_ALLY_CAPS) caps.set(a.name, a.by);
  for (const a of (d.allyCaps ?? [])) caps.set(a.name, a.by);

  const allyNames = new Set(caps.keys());
  const units = d.datasheets
    .filter((x) => x.native || (x.faction && allyNames.has(x.faction)))
    .map((x) => ({
      id: x.id,
      n: x.name,
      m: x.mode,          // standard | legends | crucible
      p: x.points,        // precio del escalón más chico
      L: (x.ladder && x.ladder.length > 1)   // escalera sólo si hay más de uno
           ? x.ladder.map((t) => [t.from, t.pts])
           : null,
      max: x.models?.max ?? null,
      c: x.cap ?? null,          // tope por fuerza: { max, at1000 }
      ld: x.leads ?? null,       // unidades a las que puede engancharse (nombres)
      // Opciones de armamento. Se descarta el grupo que sólo repite el
      // tamaño de la unidad (ya lo cubre la escalera de precios) y los
      // grupos de una sola opción sin tope, que no son una elección real.
      o: (x.options ?? [])
           // el grupo que sólo repite el tamaño de la unidad ya lo cubre la escalera
           .filter((g) => !(g.pick === 'many' && g.opts.length === 1 && g.opts[0].max > 4))
           // [nombre, tope, precio]. El precio venía de BSData y se estaba
           // descartando: 72 opciones lo tienen (Dark Lance de Drukhari = 5).
           // Grupos sin ninguna opción real: todas sus entradas vienen con
           // min = max, o sea equipo fijo. Los C'tan mostraban un panel de
           // armamento donde no había nada que elegir.
           .filter((g) => g.opts.some((e) =>
             (e.min ?? 0) !== e.max || e.model || e.max == null))
           .map((g) => ({
             n: g.n, k: g.pick,
             ow: g.owner || null,        // modelo al que pertenece la elección
             // [nombre, tope, precio, escala por tamaño]
             // [nombre, tope, precio, escala, esModelo, armas, mínimo]
             // El mínimo hace falta para distinguir el equipo FIJO de una
             // elección: si min === max, esa entrada no se elige, viene puesta.
             opts: g.opts.map((e) =>
               [e.n, e.max, Number(e.p) || 0, e.scale || null, e.model ? 1 : 0,
                e.w || null, e.min ?? 0]),
           }))
           .slice(0, 8),
      // perfil de la unidad: M T Sv W LD OC
      st: x.profile
            ? [x.profile.M, x.profile.T, x.profile.Sv, x.profile.W, x.profile.LD, x.profile.OC]
            : null,
      // Salvación invulnerable. 612 unidades la tienen y se estaba
      // descartando; en la ficha oficial cuelga debajo de la salvación.
      inv: x.profile && String(x.profile.InSv || '').trim() ? String(x.profile.InSv).trim() : null,
      // composición: [nombre, min, max, armas de fábrica]
      cp: (x.composition ?? []).map((c) => [c.n, c.min, c.max, c.w]),
      // Tamaño máximo real de la unidad, sumando sus filas. Hace falta para
      // deducir proporciones del tipo "1 cada 5 modelos", que el catálogo
      // sólo declara como el tope de la unidad más grande.
      mx: (x.composition ?? []).reduce((a, c) => a + (c.max ?? c.min ?? 0), 0) || null,
      // habilidades: [nombre, descripción]
      ab: (x.abilities ?? []).map((a) => [a.n, a.d]),
      // palabras clave del datasheet (sin la de facción, que es redundante)
      kw: (x.keywords ?? []).filter((k) => k !== x.name),
      // armas: [nombre, cuerpoACuerpo, alcance, A, hab, F, AP, D, palabras]
      w: (x.weapons ?? []).map((k) =>
           [k.n, k.melee ? 1 : 0, k.range, k.a, k.skill, k.s, k.ap, k.d, k.kw]),
      r: roleOf(x.keywords),
      fc: x.faction || null,     // facción declarada: identifica los aliados
    }));

  if (!units.length) continue;

  // Los nombres de la regla Leader vienen con mayúsculas inconsistentes
  // (GUARDIAN DEFENDERS vs Guardian Defenders). Se resuelven contra las
  // unidades de la facción y se guardan como ids; lo que no resuelve se
  // descarta, porque suele ser una unidad aliada de otro catálogo.
  // --- superponer el MFM ---
  const mf = mfmByFaction.get(normF(d.catalogueName));
  if (mf) {
    const mUnits = new Map(mf.units.map((u) => [normU(u.name), u]));
    for (const u of units) {
      const m = mUnits.get(normU(u.n));
      if (!m || !m.bands?.length) continue;

      // bands = tramos de repetición. Cada uno con su escalera por tamaño.
      // [{ from, to, tiers:[{models, pts}] }]
      u.B = m.bands.map((b) => ({
        f: b.from, t: b.to,
        s: b.tiers.map((x) => [x.models, x.pts]),
      }));
      // Precio del armamento opcional, indexado por nombre normalizado para
      // poder cruzarlo con las opciones que vienen de BSData.
      const wg = m.wargear?.length ? m.wargear : mfmWargear.get(normU(u.n));
      if (wg?.length) u.wg = Object.fromEntries(wg.map((w) => [normU(w.item), w.pts]));
      // precio de referencia: el tramo 1, escalón más chico
      u.p = u.B[0]?.s?.[0]?.[1] ?? u.p;
    }
    factionExtras = {
      det: mf.detachments.map((x) => [x.name, x.dp, x.objective, x.unique ?? null]),
      // mejoras agrupadas POR destacamento, que es como se juegan
      enhBy: Object.fromEntries(
        mf.detachments.map((x) => [x.name, x.enhancements.map((e) => [e.name, e.pts])])
      ),
      mfm: true,
    };
  }

  // Capítulos y catálogos sin MFM propio: al menos el armamento con coste.
  for (const u of units) {
    if (u.wg) continue;
    const wg = mfmWargear.get(normU(u.n));
    if (wg?.length) u.wg = Object.fromEntries(wg.map((w) => [normU(w.item), w.pts]));
  }

  const byName = new Map(units.map((u) => [u.n.toLowerCase(), u.id]));
  for (const u of units) {
    if (!u.ld) continue;
    const ids = u.ld.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
    u.ld = ids.length ? ids : null;
  }

  factions.push({
    catalogueName: d.catalogueName,
    slug: file.replace(/\.json$/, ''),
    name: d.catalogueName.replace(/^(Imperium|Chaos|Xenos) - /, ''),
    group: (d.catalogueName.match(/^(Imperium|Chaos|Xenos)/) ?? ['Otros'])[0],
    // Destacamentos y mejoras: si hay MFM, gana el MFM (trae la agrupación
    // por destacamento). Si no, se usa lo que se pudo sacar de BSData.
    // Nombres de catálogo de los que puede tomar unidades. Se convierten a
    // slugs después, cuando ya están todas las facciones cargadas.
    linkNames: d.links ?? [],
    // Topes de puntos para facciones aliadas: [nombre, {tamaño: tope}]
    // Sólo los grupos que este catálogo puede usar de verdad.
    ally: [...caps.entries()]
            .filter(([n, by]) => Object.keys(by || {}).length && usedFactions.has(n))
            .map(([n, by]) => [n, by]),
    det: factionExtras?.det ?? (d.detachments ?? []).map((x) => [x.name, x.dp, null]),
    enhBy: factionExtras?.enhBy ?? null,
    enh: (d.enhancements ?? []).map((x) => [x.name, x.pts]),
    units,
  });
}

// Resolver los enlaces entre catálogos a slugs. Sólo se conservan los que
// apuntan a una facción jugable: las Library no tienen unidades propias.
const bySlugName = new Map(factions.map((f) => [f.catalogueName, f.slug]));
for (const f of factions) {
  f.al = (f.linkNames || [])
    .map((n) => bySlugName.get(n))
    .filter((x) => x && x !== f.slug);
  delete f.linkNames;
}

factions.sort((a, b) => a.name.localeCompare(b.name));

/* Sello de compilación. Sin esto, un reporte de "no me anda" es inútil:
 * no se sabe qué versión probó la persona. Va visible en el encabezado. */
const build = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const payload = {
  build,
  roles: [...roleTable.values()].sort((a, b) => a.order - b.order),
  mfmVersion: MFM?.version ?? null,
  missions: MISSIONS,
  quickRef: MISSIONS?.quickRef ?? [],
  revision: JSON.parse(await fs.readFile(path.join(OUT_DIR, '_index.json'), 'utf8')).version,
  generatedAt: new Date().toISOString(),
  factions,
};

await fs.mkdir(APP_DIR, { recursive: true });
const target = path.join(APP_DIR, 'collection-data.json');
await fs.writeFile(target, JSON.stringify(payload));

const kb = ((await fs.stat(target)).size / 1024).toFixed(0);
const total = factions.reduce((s, f) => s + f.units.length, 0);
console.log(`✔ ${factions.length} facciones · ${total} unidades · ${kb} KB → ${target}`);

/* ------------------------------------------------------------------
 * Además genera armoury.html: el mismo index.html pero con los datos
 * incrustados adentro. Funciona con doble clic, sin servidor.
 *
 * Por qué: en file:// el navegador bloquea fetch() de archivos vecinos.
 * La versión con fetch (app/index.html) es la que se publica en Pages;
 * ésta es la que usás para probar en tu máquina.
 * ---------------------------------------------------------------- */
const html = await fs.readFile(path.join(APP_DIR, '_template.html'), 'utf8');

const inlined = html.replace(
  '/*__DATA__*/',
  'window.__ARMOURY_DATA__ = ' + JSON.stringify(payload) + ';'
);

if (inlined === html) {
  throw new Error('No encontré el marcador /*__DATA__*/ en app/_template.html');
}

// UN SOLO archivo entregable. Antes había dos (index.html con fetch y
// armoury.html autocontenido) y era imposible distinguirlos de un vistazo:
// abrir el equivocado daba "sin catálogo" sin explicación.
// index.html ahora trae los datos adentro y sirve igual con doble clic
// que publicado en GitHub Pages.
const single = path.join(APP_DIR, 'index.html');
await fs.writeFile(single, inlined);
const skb = ((await fs.stat(single)).size / 1024).toFixed(0);
console.log(`✔ app autocontenida · ${skb} KB → ${single}`);
console.log('  doble clic para abrirla; también funciona publicada.');
