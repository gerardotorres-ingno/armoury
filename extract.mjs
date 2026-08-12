#!/usr/bin/env node
/**
 * extract.mjs — Extrae datasheets (unidades) del repo BSData/wh40k-11e
 *
 * Uso:
 *   node extract.mjs                 # descarga el repo y extrae todo
 *   node extract.mjs --faction Necrons
 *   node extract.mjs --no-download   # usa la copia ya descargada en ./data
 *
 * Salida: ./output/<faccion>.json  +  ./output/_index.json
 */

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const REPO = 'BSData/wh40k-11e';
const BRANCH = 'main';
const DATA_DIR = './data';
const SRC_DIR = path.join(DATA_DIR, `wh40k-11e-${BRANCH}`);
const OUT_DIR = './output';

// ---------------------------------------------------------------- descarga

async function download() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;
  const tarball = path.join(DATA_DIR, 'repo.tar.gz');

  console.log(`↓ Descargando ${REPO}@${BRANCH} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga falló: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tarball));

  await fs.rm(SRC_DIR, { recursive: true, force: true });
  await execFileP('tar', ['-xzf', tarball, '-C', DATA_DIR]);

  // Revisión: el SHA del commit actual, para versionar la extracción.
  // Si la API de GitHub no contesta (sin red, límite de peticiones), se cae a
  // una versión por fecha: "unknown" en el changelog no le sirve a nadie.
  try {
    const meta = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`)
      .then((r) => r.json());
    if (meta?.sha) return { sha: meta.sha.slice(0, 7), date: meta.commit?.author?.date ?? null };
  } catch {}

  const today = new Date().toISOString().slice(0, 10);
  return { sha: 'd' + today.replace(/-/g, ''), date: today };
}

// ---------------------------------------------------------------- helpers

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * RESOLVEDOR DE ENLACES.
 *
 * En 11e casi todo el contenido de una unidad cuelga de `entryLinks`, no de
 * hijos directos: Battle Sisters Squad tiene 19 enlaces y ni un solo perfil
 * propio. Y los enlaces apuntan a DOS cosas distintas — entradas compartidas
 * (`selectionEntry`) y grupos compartidos (`selectionEntryGroup`)— que viven
 * en índices separados.
 *
 * Todos los extractores usan este mismo recorrido. Cada uno que resolvía
 * enlaces por su cuenta se olvidaba de alguno.
 */
// Ramas que NO son parte de la ficha de juego emparejado. Crusade es el modo
// campaña: trae Battle Traits, Battle Scars, Requisitions y reliquias, decenas
// de miles de textos que no van en la ficha.
/**
 * Ramas que no son parte de la ficha de juego emparejado.
 *
 * OJO con "Crusade": es el modo campaña, pero también aparece en nombres de
 * unidades reales — Crusader Squad, Land Raider Crusader, Crusade Ancient.
 * Filtrar por la palabra suelta borraba media facción de Black Templars.
 * Por eso los patrones son específicos del modo, no de la palabra.
 */
const SKIP_BRANCH = new RegExp([
  'crusade (relic|upgrade|point|card|rule|faction)',
  'battle trait', 'battle scar', 'battle honour',
  'requisition', 'agenda', 'enhancement',
  'boarding (action|patrol)',
].join('|'), 'i');

// Contenedores cuyo nombre es EXACTAMENTE el del modo. El grupo se llama
// "Crusade" a secas (236 apariciones) y colgaba Battle Traits como "Holy
// Crusader" de cada unidad de Sororitas. No se puede filtrar por la palabra
// suelta porque "Crusader Squad" es una unidad real.
const SKIP_EXACT = /^(crusade|trials|trials of .*|relics|honours)$/i;

/** Las entradas de Crusade se reconocen por su tipo de coste. */
function isCrusade(n) {
  return asArray(n.costs).some((c) => /^crusade/i.test(c.name) && Number(c.value) > 0);
}

/** Una mejora se reconoce por su coste, no por dónde esté colgada. */
function isEnhancement(n) {
  return asArray(n.costs).some((c) => c.name === 'Enhancements' && Number(c.value) > 0);
}

function walkAll(root, ctx, fn, maxDepth = 6) {
  // El control de repetidos va por DESTINO, no por destino+profundidad.
  // Indexar con la profundidad hacía que la misma entrada compartida se
  // recorriera a cada nivel: el JSON pasó de 1,3 MB a 54 MB.
  const seen = new Set();

  const visit = (n, d) => {
    if (!n || d > maxDepth) return;
    const nm = n.name ?? '';
    if (SKIP_BRANCH.test(nm) || SKIP_EXACT.test(nm.trim()) || isEnhancement(n) || isCrusade(n)) return;
    fn(n, d);

    // Perfiles referenciados. Se envuelven en un nodo sintético para que los
    // recolectores no tengan que distinguir entre perfil propio y enlazado.
    for (const il of asArray(n.infoLinks)) {
      const t = ctx?.profiles?.get(il.targetId);
      if (!t) continue;
      if (t.characteristics) fn({ profiles: [t] }, d);
      if (t.profiles) fn({ profiles: asArray(t.profiles) }, d);
    }

    for (const e of asArray(n.selectionEntries)) visit(e, d + 1);
    for (const g of asArray(n.selectionEntryGroups)) visit(g, d + 1);

    for (const l of asArray(n.entryLinks)) {
      const ln = (l.name ?? '').trim();
      if (SKIP_BRANCH.test(ln) || SKIP_EXACT.test(ln)) continue;
      if (seen.has(l.targetId)) continue;
      seen.add(l.targetId);
      const t = l.type === 'selectionEntryGroup'
        ? ctx?.groups?.get(l.targetId)
        : ctx?.shared?.get(l.targetId);
      if (t) visit(t, d + 1);
    }
  };

  visit(root, 0);
}

/**
 * Índice GLOBAL id -> entry.
 *
 * Clave: muchas facciones (Astra Militarum, Craftworlds, Knights...) tienen
 * sharedSelectionEntries = 0 y sus entryLinks apuntan a un catálogo Library
 * declarado en catalogueLinks. Sin índice global, esas facciones dan 0 unidades.
 */
function buildGlobalIndex(catalogues) {
  const idx = new Map();
  for (const cat of catalogues) {
    for (const e of asArray(cat.sharedSelectionEntries)) {
      if (!idx.has(e.id)) idx.set(e.id, e);
    }
  }
  return idx;
}

/**
 * Índice de PERFILES compartidos.
 *
 * Muchas unidades no llevan su perfil adentro: lo referencian con un
 * `infoLink` de tipo `profile`. Cadian Shock Troops llega a sus stats así,
 * pasando por el modelo "Shock Trooper Sergeant". Sin seguir infoLinks,
 * 80 unidades salían sin M/T/Sv.
 */
function buildProfileIndex(catalogues) {
  const idx = new Map();
  for (const cat of catalogues) {
    for (const p of asArray(cat.sharedProfiles)) if (!idx.has(p.id)) idx.set(p.id, p);
    for (const g of asArray(cat.sharedInfoGroups)) if (!idx.has(g.id)) idx.set(g.id, g);
  }
  return idx;
}

/** Igual que el anterior pero para GRUPOS compartidos: ahí viven las mejoras. */
function buildGroupIndex(catalogues) {
  const idx = new Map();
  for (const cat of catalogues) {
    for (const g of asArray(cat.sharedSelectionEntryGroups)) {
      if (!idx.has(g.id)) idx.set(g.id, g);
    }
  }
  return idx;
}

/**
 * En 11e el "modo de juego" viene como sufijo en el nombre. Sólo existen dos
 * etiquetas en todo el repo: [Legends] (517 entradas) y [Crucible] (77).
 *   standard  → legal en juego emparejado. Es lo que cuenta New Recruit.
 *   legends   → fuera de torneo, pero el jugador sigue teniendo la mini.
 *   crucible  → modo narrativo, 3 entradas fijas por facción.
 */
const TAG_RE = /\s*\[(legends|crucible)\]\s*$/i;

function modeOf(name) {
  const m = (name ?? '').match(TAG_RE);
  return m ? m[1].toLowerCase() : 'standard';
}
const cleanName = (name) => (name ?? '').replace(TAG_RE, '').trim();

/** Puntos: sólo nos interesa el coste "pts". El resto es Crusade y ruido. */
function pointsOf(entry) {
  const c = asArray(entry.costs).find((x) => x.name === 'pts');
  return c ? Number(c.value) : null;
}

/**
 * ESCALONES DE PRECIO.
 *
 * El coste base NO es el precio de la unidad grande. 279 de 1535 entradas
 * cambian de precio según el tamaño, y ese cambio vive en un `modifier`
 * que pisa el campo de coste cuando se supera un umbral de miniaturas.
 *
 *   Khorne Berzerkers → base 170, y `set pts = 330` si model > 10.
 *
 * Devuelve una escalera ordenada: [{ desde: 1, pts: 170 }, { desde: 11, pts: 330 }].
 * Para cotizar N miniaturas, se toma el último escalón con `desde <= N`.
 *
 * Sólo se leen modificadores condicionados por CANTIDAD DE MODELOS. Los que
 * dependen del destacamento o del tamaño de partida se ignoran a propósito:
 * ésos ya son motor de reglas y no hacen falta para sumar una lista.
 */
const PTS_TYPE_ID = '51b2-306e-1021-d207';

function priceLadder(entry) {
  const base = pointsOf(entry);
  if (base == null) return null;

  const steps = [{ from: 1, pts: base }];

  for (const m of asArray(entry.modifiers)) {
    if (m.type !== 'set') continue;
    if (m.field !== PTS_TYPE_ID && m.field !== 'pts') continue;

    const conds = asArray(m.conditions);
    if (conds.length !== 1) continue;          // condiciones compuestas: fuera

    const c = conds[0];
    if (c.childId !== 'model' || c.field !== 'selections') continue;

    // greaterThan 10 → aplica desde 11.  atLeast 11 → aplica desde 11.
    const from =
      c.type === 'greaterThan' ? Number(c.value) + 1 :
      c.type === 'atLeast'     ? Number(c.value)     : null;
    if (from == null) continue;

    steps.push({ from, pts: Number(m.value) });
  }

  steps.sort((a, b) => a.from - b.from);
  return steps;
}

/**
 * TOPE DE REPETICIÓN por fuerza (el equivalente a la "regla de tres").
 *
 * 1113 de 1535 entradas declaran cuántas veces puede aparecer la unidad en
 * un ejército, con una variante para partidas de 1000 puntos:
 *   Corsair Voidreavers → 6 normalmente, 4 en Incursion.
 *
 * Es una tabla de consulta, no motor de reglas: se lee la constraint
 * `max/selections/scope=force` y los modifiers que pisan su valor.
 */
function forceCapOf(entry) {
  const cap = asArray(entry.constraints).find(
    (c) => c.type === 'max' && c.field === 'selections' && c.scope === 'force'
  );
  if (!cap) return null;

  const out = { max: Number(cap.value) };

  for (const m of asArray(entry.modifiers)) {
    if (m.type !== 'set' || m.field !== cap.id) continue;
    const cond = asArray(m.conditions)[0];
    if (!cond?.childName) continue;
    const pts = /(\d+)\s*Point limit/i.exec(cond.childName);
    if (pts) out['at' + pts[1]] = Number(m.value);   // ej. at1000: 4
  }
  return out;
}

/**
 * ENGANCHE DE LÍDERES.
 *
 * A qué unidades puede unirse un personaje está en la regla `Leader`, como
 * TEXTO: "This model can be attached to the following units: ..." seguido de
 * una lista. El marcado varía entre catálogos (**^^X^^**, ^^**X**^^, viñetas
 * con -, con ■, o separado por comas), así que se limpian los marcadores y se
 * corta por cualquiera de esos separadores.
 *
 * Cobertura medida: 371 de 373 unidades con regla Leader. Las 2 restantes
 * (Warlock Conclave, Warlock Skyrunners) usan otra regla y no declaran destinos.
 *
 * Es lectura de prosa, no dato estructurado: si los mantenedores cambian la
 * redacción, esto se degrada. Por eso la app lo trata como aviso, no como ley.
 */
function leaderTargetsOf(entry) {
  let desc = null;
  const stack = [entry];
  while (stack.length) {
    const n = stack.pop();
    for (const p of asArray(n.profiles)) {
      if (p.name !== 'Leader') continue;
      const d = asArray(p.characteristics).find((c) => c.name === 'Description');
      if (d) desc = d.$text ?? d['#text'] ?? '';
    }
    for (const x of asArray(n.selectionEntries)) stack.push(x);
    for (const g of asArray(n.selectionEntryGroups)) stack.push(g);
  }
  if (desc == null) return null;

  const cut = desc.replace(/\*\*/g, '').replace(/\^\^/g, '')
                  .split(/attached to the following units?:/i)[1];
  if (!cut) return [];

  return cut
    .replace(/\r/g, '')
    .split(/\n\s*[-•■]\s*|\s*■\s*|\n\s*-\s*|,|\n/)
    .map((x) => x.trim().replace(/^[-•■]\s*/, '').replace(/[.;]$/, ''))
    .filter((x) => x && x.length < 60 && !/^or$/i.test(x) &&
                   !/excluding|keyword|following/i.test(x));
}

/**
 * OPCIONES DE ARMAMENTO.
 *
 * En 11e el armamento casi no cuesta puntos: de 4426 entradas de opción en
 * todo el repo, sólo 72 tienen coste distinto de 0 (unas pocas de Drukhari).
 * O sea que elegir armas NO mueve el total de la lista: cambia el detalle.
 *
 * Se modela de dos formas distintas y hay que leer las dos:
 *   variantes de modelo → "Khorne Berzerker w/ eviscerator", max 4
 *   grupos de mejora    → "Pistol", elegir 1 entre N (min 1 / max 1)
 *
 * Se extraen los topes planos (max:N). Las proporciones del tipo "1 cada 5
 * modelos" viven en modifiers y NO se resuelven: eso ya es motor de reglas.
 */
function optionsOf(entry, ctx) {
  const groups = [];
  const seenG = new Set();

  /**
   * Tope de una opción, incluida su ESCALA POR TAMAÑO.
   *
   * "1 cada 5 modelos" no está como proporción: está como un máximo base más
   * un modificador que lo sube cuando la unidad alcanza cierto tamaño.
   *   Terminator w/ Heavy Weapon → max 1, y `set max = 2` si la unidad tiene 10.
   * Se devuelve como escalera [[10, 2]] y la app elige según el tamaño elegido.
   */
  const capOf = (node) => {
    const cs = asArray(node.constraints);
    const mx = cs.find((c) => c.type === 'max' && c.field === 'selections');
    const mn = cs.find((c) => c.type === 'min' && c.field === 'selections');

    const scale = [];
    if (mx) {
      for (const m of [...asArray(node.modifiers),
                       ...asArray(node.modifierGroups).flatMap((g) => asArray(g.modifiers))]) {
        if (m.type !== 'set' || m.field !== mx.id) continue;
        const cond = asArray(m.conditions)[0];
        if (!cond || cond.field !== 'selections') continue;
        const at = Number(cond.value);
        if (!Number.isFinite(at)) continue;
        scale.push([at, Number(m.value)]);
      }
      scale.sort((a, b) => a[0] - b[0]);
    }

    return {
      min: mn ? Number(mn.value) : 0,
      max: mx ? Number(mx.value) : null,
      scale: scale.length ? scale : null,
    };
  };

  const readGroup = (g, owner) => {
    if (!g || !g.name || seenG.has(g.id ?? g.name)) return;
    if (SKIP_BRANCH.test(g.name) || SKIP_EXACT.test(g.name.trim())) return;
    seenG.add(g.id ?? g.name);

    const linked = asArray(g.entryLinks)
      .filter((l) => l.type === 'selectionEntry')
      .map((l) => {
        const t = ctx?.shared?.get(l.targetId);
        return t ? { ...t, name: l.name || t.name } : null;
      })
      .filter(Boolean);

    // Las mejoras se cuelan acá cuando llegan por enlace: el grupo puede no
    // llamarse "Enhancements" aunque sus opciones lo sean. Se reconocen por
    // el coste, igual que en el resto del extractor.
    const opts = [...asArray(g.selectionEntries), ...linked]
      .filter((e) => (e.type === 'model' || e.type === 'upgrade') &&
                     !isEnhancement(e) && !isCrusade(e))
      .map((e) => ({
        n: e.name, ...capOf(e),
        p: asArray(e.costs).find((c) => c.name === 'pts')?.value ?? 0,
      }));
    if (!opts.length) return;

    const gc = capOf(g);
    const pick = gc.max === 1 ? 'one' : 'many';
    const isChoice = opts.some((o) => o.min !== o.max) || (pick === 'one' && opts.length > 1);
    // De qué MODELO son estas opciones. En una escuadra, "Weapon 1" es del
    // sargento y la tropa lleva equipo fijo; mostrarlas planas hace creer que
    // la elección aplica a toda la unidad.
    if (isChoice) groups.push({ n: g.name, owner: owner ?? null, min: gc.min, max: gc.max, pick, opts });
  };

  walkAll(entry, ctx, (n) => {
    // El dueño es el modelo más cercano hacia arriba. `n` es ese nodo cuando
    // es de tipo model; si no, las opciones son de la unidad entera.
    const owner = n.type === 'model' && n.name !== entry.name ? n.name : null;

    for (const g of asArray(n.selectionEntryGroups)) readGroup(g, owner);
    for (const l of asArray(n.entryLinks)) {
      if (l.type !== 'selectionEntryGroup') continue;
      const g = ctx?.groups?.get(l.targetId);
      if (g) readGroup({ ...g, name: l.name || g.name }, owner);
    }
  });

  return groups.length ? groups : null;
}

/**
 * COMPOSICIÓN DE LA UNIDAD.
 *
 * BSData no trae el bloque "Unit Composition" como texto: no existe ese tipo
 * de perfil. Pero la información está en la estructura — los modelos con sus
 * topes y sus armas de fábrica:
 *
 *   Assault Intercessor Sergeant  min 1 / max 1
 *   Assault Intercessors          min 4 / max 9
 *
 * Se reconstruye a partir de eso. El armamento base sale de los hijos y
 * enlaces de cada modelo que resuelven a un arma.
 */
function compositionOf(entry, ctx, weaponNames) {
  const rows = [];
  const seen = new Set();

  const gearOf = (model) => {
    const out = [];
    const add = (nm) => { if (nm && weaponNames.has(nm) && !out.includes(nm)) out.push(nm); };
    for (const e of asArray(model.selectionEntries)) add(e.name);
    for (const l of asArray(model.entryLinks)) {
      if (l.type !== 'selectionEntry') continue;
      add(l.name);
      const t = ctx?.shared?.get(l.targetId);
      if (t) add(t.name);
    }
    return out;
  };

  const resolve = (list) => list
    .map((l) => {
      if (l.type === 'model' || l.type === 'upgrade') return l;
      if (l.targetId) {
        const t = ctx?.shared?.get(l.targetId);
        return t ? { ...t, name: l.name || t.name } : null;
      }
      return l;
    })
    .filter(Boolean);

  const addModel = (e) => {
    if (!e || e.type !== 'model' || seen.has(e.name)) return;
    const cs = asArray(e.constraints).filter((c) => c.field === 'selections');
    const mn = cs.find((c) => c.type === 'min');
    const mx = cs.find((c) => c.type === 'max');
    seen.add(e.name);
    rows.push({
      n: e.name,
      min: mn ? Number(mn.value) : (mx ? null : 1),
      max: mx ? Number(mx.value) : null,
      w: gearOf(e),
    });
  };

  // PRIMER NIVEL únicamente. La composición son los modelos que cuelgan
  // directo de la unidad o de sus grupos inmediatos. Las variantes de arma
  // viven en subgrupos anidados y ya salen en `options`; incluirlas hacía
  // que Berzerkers mostrara cuatro filas de tropa en vez de dos.
  for (const e of resolve([...asArray(entry.selectionEntries), ...asArray(entry.entryLinks)]))
    addModel(e);

  for (const g of asArray(entry.selectionEntryGroups))
    for (const e of resolve([...asArray(g.selectionEntries), ...asArray(g.entryLinks)]))
      addModel(e);

  // Unidad de un solo modelo: personajes y vehículos no tienen grupo.
  if (!rows.length && entry.type === 'model')
    rows.push({ n: entry.name, min: 1, max: 1, w: gearOf(entry) });

  // Las filas "w/ algo" son variantes de armamento, no composición. Se
  // descartan si queda al menos una fila normal; si TODAS son variantes
  // (Necron Warriors, que sólo existe como "w/ gauss flayer" y "w/ gauss
  // reaper"), se colapsan en una sola con el nombre de la unidad.
  const isVariant = (r) => / w\/ | with /i.test(' ' + r.n + ' ');
  const plain = rows.filter((r) => !isVariant(r));

  if (plain.length) return plain;

  if (rows.length) {
    const max = Math.max(...rows.map((r) => r.max ?? 0)) || null;
    const min = Math.min(...rows.map((r) => r.min ?? max ?? 1)) || null;
    const w = [...new Set(rows.flatMap((r) => r.w))];
    return [{ n: entry.name, min, max, w }];
  }
  return null;
}

/** Facción declarada en categoryLinks: "Faction: Necrons" */
function factionOf(entry) {
  for (const cl of asArray(entry.categoryLinks)) {
    if (typeof cl.name === 'string' && cl.name.startsWith('Faction: ')) {
      return cl.name.slice('Faction: '.length);
    }
  }
  return null;
}

/** Keywords útiles (Infantry, Character, Battleline, Vehicle...) */
function keywordsOf(entry) {
  return asArray(entry.categoryLinks)
    .map((cl) => cl.name)
    .filter((n) => typeof n === 'string' && !n.startsWith('Faction: '));
}

/**
 * Cuántas miniaturas trae la unidad.
 * En 11e el tamaño vive en constraints de los selectionEntryGroups internos
 * o en la propia entrada de tipo `model`. Devolvemos min/max cuando se puede.
 */
function modelCountOf(entry, shared) {
  // Una entrada `model` es 1 miniatura por definición
  if (entry.type === 'model') return { min: 1, max: 1 };

  let min = 0;
  let max = 0;
  let found = false;

  const visit = (node, depth = 0) => {
    if (!node || depth > 3) return;
    for (const child of asArray(node.selectionEntries)) {
      if (child.type === 'model') {
        const cs = asArray(child.constraints);
        const mn = cs.find((c) => c.type === 'min' && c.field === 'selections');
        const mx = cs.find((c) => c.type === 'max' && c.field === 'selections');
        if (mn || mx) {
          found = true;
          min += mn ? Number(mn.value) : 0;
          max += mx ? Number(mx.value) : 0;
        }
      }
      visit(child, depth + 1);
    }
    for (const g of asArray(node.selectionEntryGroups)) visit(g, depth + 1);
  };

  visit(entry);
  return found ? { min: min || null, max: max || null } : { min: null, max: null };
}

/**
 * HABILIDADES. Perfiles con typeName "Abilities".
 *
 * Se descarta "Leader": su texto ya se convirtió en la lista estructurada de
 * destinos (campo `leads`), y repetirlo aquí duplicaría medio kilobyte por
 * personaje sin agregar nada.
 *
 * El marcado ^^ y ** del texto se limpia: es sintaxis de BattleScribe para
 * resaltar, no contenido.
 */
function abilitiesOf(entry, ctx) {
  const acc = [];
  const seen = new Set();

  const clean = (t) => String(t ?? '')
    .replace(/\^\^/g, '').replace(/\*\*/g, '')
    .replace(/\s+/g, ' ').trim();

  walkAll(entry, ctx, (n) => {
    for (const p of asArray(n.profiles)) {
      if (p.typeName !== 'Abilities') continue;
      if (p.name === 'Leader' || seen.has(p.name)) continue;
      seen.add(p.name);
      const desc = asArray(p.characteristics)
        .map((c) => clean(c.$text ?? c['#text'])).filter(Boolean).join(' ');
      if (desc) acc.push({ n: p.name, d: desc });
    }
  });

  return acc.length ? acc : null;
}

/**
 * ARMAS. Vienen como profiles con typeName "Ranged Weapons" o "Melee Weapons".
 * Una unidad puede repetir la misma arma en varias variantes de modelo, así
 * que se deduplica por nombre.
 */
function weaponsOf(entry, ctx) {
  const acc = [];
  const seen = new Set();

  walkAll(entry, ctx, (n) => {
    for (const p of asArray(n.profiles)) {
      const t = p.typeName;
      if (t !== 'Ranged Weapons' && t !== 'Melee Weapons') continue;
      if (seen.has(p.name)) continue;
      seen.add(p.name);

      const ch = {};
      for (const c of asArray(p.characteristics)) ch[c.name] = c.$text ?? c['#text'] ?? '';
      acc.push({
        n: p.name,
        melee: t === 'Melee Weapons',
        range: ch.Range ?? '',
        a: ch.A ?? '',
        skill: ch.WS ?? ch.BS ?? '',
        s: ch.S ?? '',
        ap: ch.AP ?? '',
        d: ch.D ?? '',
        kw: ch.Keywords && ch.Keywords !== '-' ? ch.Keywords : '',
      });
    }
  });

  return acc.length ? acc : null;
}

/** Perfil de la unidad (M, T, SV, W, LD, OC) desde profiles con typeName "Unit". */
function unitProfileOf(entry, ctx) {
  let unit = null;
  walkAll(entry, ctx, (n) => {
    if (unit) return;
    for (const p of asArray(n.profiles)) if (p.typeName === 'Unit') { unit = p; return; }
  });
  if (!unit) return null;

  const out = {};
  for (const ch of asArray(unit.characteristics)) {
    out[ch.name] = ch.$text ?? ch['#text'] ?? ch.value ?? null;
  }
  return out;
}

// ---------------------------------------------------------------- extracción

function extractCatalogue(catalogue, fileName, shared, groupIndex, libIndex, profileIndex) {
  const ctx = { shared, groups: groupIndex, profiles: profileIndex };
  if (catalogue.library === true) return null; // las Library no son facciones jugables

  const datasheets = [];
  const unresolved = [];

  for (const link of asArray(catalogue.entryLinks)) {
    const target = shared.get(link.targetId);

    if (!target) {
      unresolved.push({ name: link.name ?? null, targetId: link.targetId });
      continue;
    }
    // Sólo unidades y modelos individuales. `upgrade` = Detachment, wargear, etc.
    if (target.type !== 'unit' && target.type !== 'model') continue;
    if (target.hidden === true || link.hidden === true) continue;

    const rawName = link.name || target.name;
    const mode = modeOf(rawName);

    datasheets.push({
      id: target.id,
      linkId: link.id,
      name: cleanName(rawName),
      rawName,
      type: target.type,
      mode,
      legends: mode === 'legends',
      points: pointsOf(target),
      ladder: priceLadder(target),
      cap: forceCapOf(target),
      leads: leaderTargetsOf(target),
      options: optionsOf(target, ctx),
      weapons: weaponsOf(target, ctx),
      composition: null,   // se completa abajo, necesita los nombres de armas
      abilities: abilitiesOf(target, ctx),
      faction: factionOf(target),
      keywords: keywordsOf(target),
      models: modelCountOf(target, shared),
      profile: unitProfileOf(target, ctx),
    });
  }

  // Destacamentos con su coste en PUNTOS DE DESTACAMENTO.
  //
  // El coste no está en un campo aparte: es un `cost` con name "Detachment
  // Points" (costType 82ae-1066-5107-6ae0). Buscarlo por nombre de grupo no
  // lo encuentra nunca; hay que mirar los costes.
  //   Berzerker Warband 3 · Cult of Blood 2 · Brazen Engines 1
  const costNamed = (node, name) => {
    const c = asArray(node.costs).find((x) => x.name === name);
    return c ? Number(c.value) : 0;
  };

  // Barrido directo por COSTE en lugar de recorrer el árbol.
  //
  // La estructura varía demasiado entre facciones: a veces el Detachment
  // cuelga del catálogo, a veces de su Library, a veces con un nivel extra de
  // indirección. Perseguir el árbol falla en la mitad de los casos.
  //
  // Lo estable es el coste: una entrada con "Detachment Points" > 0 ES un
  // destacamento, y una con coste "Enhancements" > 0 ES una mejora. Se barre
  // este catálogo y su Library propia (la que lleva su nombre en el título,
  // para no arrastrar las de Knights o Agents, que se enlazan como aliados).
  const core = catalogue.name.replace(/^(Imperium|Chaos|Xenos)\s*-\s*/, '').trim();
  const sources = [catalogue];
  for (const cl of asArray(catalogue.catalogueLinks)) {
    const lib = libIndex.get(cl.targetId);
    if (lib && lib.library === true && (lib.name ?? '').includes(core)) sources.push(lib);
  }

  const detachments = [];
  const enhancements = [];
  const seenDet = new Set();
  const seenEnh = new Set();

  for (const src of sources) {
    const stack = [...asArray(src.sharedSelectionEntries), ...asArray(src.sharedSelectionEntryGroups)];
    while (stack.length) {
      const n = stack.pop();
      if (n.name) {
        const dp = costNamed(n, 'Detachment Points');
        if (dp > 0 && !seenDet.has(n.name)) { seenDet.add(n.name); detachments.push({ name: n.name, dp }); }
        if (costNamed(n, 'Enhancements') > 0 && !seenEnh.has(n.name)) {
          seenEnh.add(n.name);
          enhancements.push({ name: n.name, pts: costNamed(n, 'pts') });
        }
      }
      for (const e of asArray(n.selectionEntries)) stack.push(e);
      for (const g of asArray(n.selectionEntryGroups)) stack.push(g);
    }
  }
  detachments.sort((a, b) => a.name.localeCompare(b.name));

  enhancements.sort((a, b) => a.name.localeCompare(b.name));

  // La composición necesita saber qué nombres son armas, así que se calcula
  // después de extraerlas.
  for (const ds of datasheets) {
    const target = shared.get(ds.id);
    if (!target) continue;
    const names = new Set((ds.weapons ?? []).map((w) => w.n));
    ds.composition = compositionOf(target, ctx, names);

    // Los grupos de COMPOSICIÓN se colaban entre las opciones de equipo:
    // "Assault Intercessors [many]: Sergeant / Assault Intercessors" no es
    // una elección de armamento, es la tropa de la unidad. Se descartan los
    // grupos cuyas opciones son todas modelos de la composición.
    const compNames = new Set((ds.composition ?? []).map((c) => c.n));
    if (ds.options) {
      ds.options = ds.options.filter((g) => {
        const allComp = g.opts.every((o) => compNames.has(o.n));
        return !allComp;
      });
      if (!ds.options.length) ds.options = null;
    }
  }

  datasheets.sort((a, b) => a.name.localeCompare(b.name));

  // --- nativas vs aliadas --------------------------------------------------
  // Un catálogo importa unidades de otros (GSC trae Astra Militarum como Brood
  // Brothers, CSM trae Daemons, casi todos traen Titans). Para el tracker de
  // colección sólo interesan las NATIVAS: si no separás, GSC pasa de 28 a 153.
  const factionTally = new Map();
  for (const d of datasheets) {
    if (!d.faction) continue;
    factionTally.set(d.faction, (factionTally.get(d.faction) ?? 0) + 1);
  }
  const catTokens = catalogue.name.toLowerCase();
  let nativeFaction =
    [...factionTally.keys()].find((f) => catTokens.includes(f.toLowerCase())) ??
    [...factionTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    null;

  for (const d of datasheets) d.native = d.faction === nativeFaction;

  const native = datasheets.filter((d) => d.native);

  return {
    catalogueId: catalogue.id,
    catalogueName: catalogue.name,
    nativeFaction,
    // Catálogos de los que esta facción puede tomar unidades al armar una
    // lista. Ultramarines enlaza a "Imperium - Space Marines" (su base) más
    // Imperial Knights y Agents como aliados. La COLECCIÓN sigue mostrando
    // sólo lo nativo — si no, tus Intercessors aparecerían en trece capítulos.
    links: asArray(catalogue.catalogueLinks)
      .map((cl) => libIndex.get(cl.targetId)?.name ?? cl.name)
      .filter(Boolean),
    detachments,
    enhancements,
    revision: catalogue.revision,
    file: fileName,
    counts: {
      total: datasheets.length,
      native: native.length,
      // `matched` es EL número a comparar contra New Recruit
      matched: native.filter((d) => d.mode === 'standard').length,
      legends: native.filter((d) => d.mode === 'legends').length,
      crucible: native.filter((d) => d.mode === 'crucible').length,
      allied: datasheets.length - native.length,
    },
    unresolved,
    datasheets,
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const noDownload = args.includes('--no-download');
  const factionArg = args.includes('--faction')
    ? args[args.indexOf('--faction') + 1]
    : null;

  let version = { sha: 'local', date: null };
  if (!noDownload) version = await download();

  const files = (await fs.readdir(SRC_DIR)).filter((f) => f.endsWith('.json'));
  await fs.mkdir(OUT_DIR, { recursive: true });

  // PASO 1: cargar TODOS los catálogos (incluidas las Library y el .gst)
  const loaded = [];
  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(SRC_DIR, file), 'utf8'));
    const cat = raw.catalogue ?? raw.gameSystem;
    if (cat) loaded.push({ file, cat });
  }

  // PASO 2: índice global para resolver entryLinks entre catálogos
  const shared = buildGlobalIndex(loaded.map((l) => l.cat));
  const groupIndex = buildGroupIndex(loaded.map((l) => l.cat));
  const libIndex = new Map(loaded.map(({ cat }) => [cat.id, cat]));
  const profileIndex = buildProfileIndex(loaded.map((l) => l.cat));
  console.log(`  Índice global: ${shared.size} entradas compartidas de ${loaded.length} archivos`);

  const index = [];
  let grandTotal = 0;

  // PASO 3: extraer facción por facción
  for (const { file, cat } of loaded) {
    if (factionArg && !file.toLowerCase().includes(factionArg.toLowerCase())) continue;

    const result = extractCatalogue(cat, file, shared, groupIndex, libIndex, profileIndex);
    if (!result) continue;
    if (result.datasheets.length === 0) continue;

    const slug = result.catalogueName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    await fs.writeFile(
      path.join(OUT_DIR, `${slug}.json`),
      JSON.stringify({ version, ...result }, null, 2)
    );

    index.push({
      slug,
      name: result.catalogueName,
      revision: result.revision,
      ...result.counts,
      unresolved: result.unresolved.length,
    });
    grandTotal += result.counts.matched;
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(
    path.join(OUT_DIR, '_index.json'),
    JSON.stringify({ version, generatedAt: new Date().toISOString(), grandTotal, catalogues: index }, null, 2)
  );

  // -------- reporte en consola: esto es lo que comparás contra New Recruit
  console.log(`\n  Revisión de datos: ${version.sha}  (${version.date ?? 's/f'})\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('CATÁLOGO', 44), pad('MATCHED', 9), pad('LEGENDS', 9),
    pad('CRUCIBLE', 10), pad('ALIADAS', 9), 'SIN RESOLVER'
  );
  console.log('-'.repeat(95));
  for (const c of index) {
    console.log(
      pad(c.name, 44), pad(c.matched, 9), pad(c.legends, 9),
      pad(c.crucible, 10), pad(c.allied, 9), c.unresolved || ''
    );
  }
  console.log('-'.repeat(95));
  console.log(pad('TOTAL MATCHED', 44), grandTotal);
  console.log('\n  ⇒ MATCHED es la columna a comparar contra New Recruit.');
  console.log(`\n→ ${index.length} catálogos escritos en ${OUT_DIR}/\n`);
}

main().catch((e) => {
  console.error('✖', e.message);
  process.exit(1);
});
