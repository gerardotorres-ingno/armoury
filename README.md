# Armoury

Warhammer 40,000 collection tracker and list composer. Reads its data from two
public sources that update themselves, and reports what changed each week.

No backend, no accounts, no cost. Your collection lives in your browser.

## Sources and precedence

| Source | Manda en |
|---|---|
| [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e) | Catálogo: unidades, keywords, armas, habilidades, roles |
| [BSData/wh40k-11e-mfm](https://github.com/BSData/wh40k-11e-mfm) | Puntos: umbrales de requisición, tamaños, destacamentos, mejoras |

Sin el MFM la app funciona igual, con precios aproximados de BSData.

## Scripts

    npm install
    node extract.mjs        # catálogo → output/
    node mfm.mjs            # puntos oficiales → output-mfm/
    node prepare-data.mjs   # genera app/index.html (autocontenido)

O `npm run build`, que corre los tres en orden.

`node diff.mjs <snapshot-viejo> output` compara dos extracciones y escribe el
changelog: altas, bajas, renombres, recreaciones, cambios de puntos y de Legends.

## La app

`app/index.html` es un solo archivo con el catálogo adentro: doble clic y
funciona, sin servidor. Ese mismo archivo es el que se publica.

`app/_template.html` es la fuente que se edita. `index.html` es generado y se
pisa en cada build — no lo edites.

## Actualización automática

`.github/workflows/data.yml` corre los lunes: extrae, baja el MFM, compara
contra `snapshots/latest`, escribe `changelogs/AAAA-MM-DD.md`, regenera la app
y la publica en GitHub Pages. Requiere **Settings → Pages → Source: GitHub Actions**.

## Qué valida el compositor

Revisa: total de puntos, umbrales de requisición, topes de repetición por
unidad y tamaño de partida, presupuesto de Detachment Points, etiquetas Unique,
legalidad Legends/Crucible, enganche de líderes, topes de armamento y tu colección.

No revisa: mínimos de línea, reglas propias de cada destacamento, ni límites por
proporción ("uno cada cinco modelos"). La app lo dice en pantalla.

## Notas de datos

- Los datasheets vienen en JSON plano, no en XML de BattleScribe.
- Legends y Crucible son sufijos en el nombre: `Anrakyr the Traveller [Legends]`.
- Las facciones grandes tienen `sharedSelectionEntries: 0` y resuelven contra un
  catálogo Library: hace falta un índice global sobre los 46 archivos.
- Destacamentos y mejoras se detectan por **tipo de coste**, no por nombre de
  grupo: `Detachment Points` y `Enhancements` son costTypes del game system.
- El presupuesto de DP por tamaño de partida no está en ninguna fuente; es
  editable en cada lista.
