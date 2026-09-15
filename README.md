[README.md](https://github.com/user-attachments/files/32257326/README.md)
# Armoury

Warhammer 40,000 collection tracker and list composer. Reads its data from two
public sources that update themselves, and reports what changed each week.

No backend, no accounts, no cost. Your collection lives in your browser.

## Sources and precedence

| Source | Manda en |
|---|---|
| [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e) | Catálogo: unidades, keywords, armas, habilidades, roles |
| [BSData/wh40k-11e-mfm](https://github.com/BSData/wh40k-11e-mfm) | Puntos: umbrales de requisición, tamaños, destacamentos, mejoras |
| [IRONBUILT-LLC/ironbuilt-data](https://github.com/IRONBUILT-LLC/ironbuilt-data) (CC BY-SA 4.0) | Misiones primarias, secundarias y despliegues |
| [tabletop-developer-consortium/40kdc-data](https://github.com/tabletop-developer-consortium/40kdc-data) | Metadatos de palabras clave y estratagemas (sin texto de reglas) |

Sin el MFM la app funciona igual, con precios aproximados de BSData.

## Scripts

    npm install
    node extract.mjs        # catálogo → output/
    node mfm.mjs            # puntos oficiales → output-mfm/
    node missions.mjs       # misiones y despliegues → output-missions/
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

## Contador de visitas

Desactivado por defecto: sin configurar, la app no hace ninguna petición externa.

Para saber si alguien la usa, creá un sitio gratis en [GoatCounter](https://www.goatcounter.com)
y poné su código en la constante `ANALYTICS`, al principio de `app/_template.html`:

```js
const ANALYTICS = 'tucodigo';   // https://tucodigo.goatcounter.com
```

Cuenta visitas anónimas, sin cookies ni datos personales. Al activarlo, la
pantalla de inicio lo declara sola: la promesa de que nada sale del dispositivo
tiene que seguir siendo cierta.

### Cómo leer si alguien vuelve

Una analítica sin cookies cuenta visitas, no personas: no puede decir si
alguien volvió. Por eso la app informa el **tramo de uso** como si fuera una
página distinta:

| Ruta en GoatCounter | Significa |
|---|---|
| `/open/first` | Alguien abrió la app por primera vez en ese navegador |
| `/open/returning-2-5` | Segunda a quinta apertura |
| `/open/regular-6plus` | Sexta en adelante |

Nunca viaja quién, sólo el tramo. Se lee así:

- **Sólo `first`** — la prueban y no vuelven. El problema está en el primer uso.
- **`first` alto y `returning` bajo** — mismo diagnóstico, con volumen.
- **`regular-6plus` creciendo** — hay gente usándola de verdad. Ese es el
  número que justifica invertir en sincronización o en cualquier otra cosa.

Además, la pantalla de inicio muestra cuántas veces se abrió la app **en ese
navegador**. Es local, no viaja a ningún lado, y sirve para que cada persona
vea su propio uso.

## Atribución

El dataset de misiones proviene de
[IRONBUILT-LLC/ironbuilt-data](https://github.com/IRONBUILT-LLC/ironbuilt-data),
bajo CC BY-SA 4.0. La licencia obliga a atribuir y a compartir igual: la
atribución se muestra dentro de la app, en el panel de misiones secundarias.

Ninguna de las tres fuentes está afiliada a Games Workshop. Warhammer 40,000 y
todos los nombres, reglas y puntos asociados son propiedad intelectual de
Games Workshop Limited.
