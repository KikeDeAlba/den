# Den

**Den** (madriguera) es la app de escritorio que junta las herramientas
`@kikedealba` en la barra de menús: los cronómetros de **bita**, las páginas y
las notas de **inkwell**, lo pendiente de pasar a Jira de **tally**, las
conexiones de **atl** y las reuniones de **recap**. El icono es el mapache.

Den no trae ninguna de ellas dentro ni depende de su código. Las encuentra en el
registro de `@kikedealba/kit` cuando están instaladas, les habla por su CLI con
`--json` y enciende solo los módulos de las que responden. Si falta una, su
parte desaparece y en Ajustes aparece una tarjeta con el comando para
instalarla. Cada módulo tiene una sola dueña: no hay respaldos de una
herramienta a otra.

| Herramienta | Qué enciende en Den |
|---|---|
| `bita` | Las pestañas Ahora, Hoy y Repos, y el arranque de cronómetros |
| `inkwell` | La ventana de notas, el backlog, el historial de las páginas, la sincronización con Confluence y las notas de cada cronómetro |
| `tally` | La pestaña Jira: lo medido que todavía no se registró |
| `atl` | Las conexiones con Jira y Confluence (los sitios de Atlassian) |
| `recap` | Reuniones, el asistente en vivo, los tipos de reunión del lanzador y las grabaciones en Almacenamiento |

## Requisitos

Las herramientas que quieras usar, instaladas con su `setup`, que es el que las
deja en el registro:

```sh
npm install -g @kikedealba/bita && bita setup
npm install -g @kikedealba/inkwell && inkwell setup
npm install -g @kikedealba/tally && tally setup
npm install -g @kikedealba/atl && atl setup
npm install -g @kikedealba/recap && recap setup
npm install -g @kikedealba/gaze && gaze setup
```

Cada manifiesto puede traer su propia pista de instalación (`install`); Den la
prefiere sobre la de arriba.

## Cómo encuentra las herramientas

Lee el mismo directorio que `kit`:

| Sistema | Registro |
|---|---|
| macOS / Linux | `${XDG_CONFIG_HOME:-~/.config}/kikedealba/tools.d/<herramienta>.json` |
| Windows | `%APPDATA%\kikedealba\tools.d\<herramienta>.json` |

`KIT_REGISTRY_DIR` lo cambia. De cada manifiesto usa `bin`, la línea de comando
completa con rutas absolutas, así que no depende del `PATH`. Un manifiesto cuyo
ejecutable ya no existe cuenta como roto, y uno que no es válido se lista en
Ajustes con sus problemas.

Al arrancar le pregunta a cada una `capabilities --json` y guarda la respuesta
durante la sesión. Los módulos se deciden por capacidad, no por versión ni por
el texto de un error:

| Módulo | Lo enciende |
|---|---|
| Cronómetros, Hoy, Repos | `bita` respondiendo |
| Jira | `tally` con `timesheet.summary` |
| Notas (páginas) | `inkwell` con `docs.page.read` |
| Notas de cada cronómetro | `inkwell` con `docs.entry-notes` |
| Backlog, historial, Confluence | `inkwell` con `docs.backlog`, `docs.history`, `docs.confluence.sync` |
| Propuestas | `recap` e `inkwell` con `docs.propose` |
| Sitios de Atlassian | `atl` respondiendo |
| Reuniones, asistente en vivo | `recap` respondiendo |
| Cerebro (grafo) | `gaze` con `memory.graph.read`; la búsqueda, además con `memory.search` |

Una herramienta registrada que no contesta queda apagada hasta que vuelva a
responder.

La pestaña **Hoy** no le pide un resumen a nadie: lee `bita entries today|week
--json` y agrupa en Den por título y proyecto (sin distinguir mayúsculas,
espacios ni la puntuación final), con la duración de cada bloque, los que están
corriendo incluidos, y avisa de los días con cronómetros solapados. La pestaña
**Jira** es `tally summary --pending --json`: los grupos, la estimación y lo que
queda fuera de Jira los decide tally, y la clave de Jira de cada proyecto (en
Repos y en los ajustes del espacio) sale de `tally map list --json`, igual que
la etiqueta «sin Jira» de Repos (`jira: false` en esa lista). Sin tally no hay
etiqueta. Den lee
igual los proyectos y las entradas de bita 0.18 y de bita 1.0, que ya no traen
`registered`, `issueKey` ni los datos de Jira. Las notas de cada cronómetro son
`inkwell note ls|show|search`.

Si inkwell todavía no trae los docs de bita (`inkwell migrate status --json`
dice `migrated: false`), Ajustes lo avisa con el comando para migrarlos.

El directorio `tools.d` se vigila: instalar o quitar una herramienta enciende o
apaga sus módulos sin reiniciar. «Volver a buscar» en Ajustes fuerza la
relectura.

Para ver lo que Den decide sin abrir la ventana:

```sh
src-tauri/target/debug/den --tools-status
```

## Instalación

Cada versión se publica en
[GitHub Releases](https://github.com/KikeDeAlba/den/releases) como un
`.dmg` para Apple Silicon, firmado ad hoc y sin notarizar: la primera vez hay
que abrirlo con clic derecho → Abrir. Para compilarlo tú mismo, sigue estos
pasos.

### 1. Toolchain

```sh
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Reinicia la terminal después de instalar Rust.

### 2. Clonar

```sh
git clone git@github.com:KikeDeAlba/den.git
cd den
pnpm install
```

### 3. Compilar

```sh
pnpm tauri build --bundles app
cp -R src-tauri/target/release/bundle/macos/Den.app /Applications/
open /Applications/Den.app
```

La primera compilación baja y construye unos 500 crates: entre cinco y quince
minutos. Las siguientes, un minuto.

El `.app` va firmado **ad hoc**, que es lo que evita el diálogo de «está dañada»
al moverlo. No está notarizado, así que en otro Mac habrá que abrirlo la primera
vez desde Ajustes → Privacidad y seguridad.

No hay icono en el Dock ni ventana: vive en la barra de arriba. Para cerrarlo,
clic derecho en el icono → **Salir de Den**.

### Si venías de bita-desktop

El identificador cambió de `com.kikedealba.bita-desktop` a
`com.kikedealba.den`. En el primer arranque Den copia `live.json` (los ajustes
del asistente y el atajo) desde la carpeta vieja si en la nueva todavía no
existe. La vieja no se toca. Lo que la ventana de notas guarda en el
navegador (anchos de los carriles, tamaño del texto, el último espacio) vive en
el almacén del identificador viejo y empieza de cero.

## Qué hace

| Pestaña | Qué enseña |
|---|---|
| **Ahora** | Los cronómetros vivos con su segundero. Arrancar, parar, y nombrar un borrador |
| **Hoy** | Lo trabajado hoy o esta semana, por tarea, con su estimación y sus solapes |
| **Jira** | Lo que sigue sin registrar. Solo lectura |
| **Repos** | Las rutas que resuelven a cada proyecto, y el catálogo de proyectos |

Y una **ventana aparte** para leer las notas, que se abre con el icono de
documento de la barra o con «Ver nota» en la tarjeta del cronómetro.

Dos cosas del dominio que la interfaz intenta hacer evidentes:

- Un **borrador** es un cronómetro sin título. Arranca vacío y se va rellenando
  solo durante la sesión de Claude Code. Va punteado, no en rojo: es un estado
  normal, y mientras siga sin nombre no puede llegar a Jira.
- **Trabajado → estimado**, siempre en ese orden. Las dos cifras van a Jira, pero
  a campos distintos: lo trabajado es el worklog y lo redondeado es la estimación
  original. El redondeo sube a la media hora siguiente **por tarea**, así que el
  total del día es la suma de estimaciones ya redondeadas, nunca el redondeo de
  la suma.

## Desarrollo

```sh
pnpm tauri dev      # la app, con recarga del panel
pnpm typecheck      # el frontend
pnpm measure        # mide el panel en WebKit y falla si algo se sale
cargo test          # desde src-tauri/
```

`pnpm measure` existe porque un panel roto se veía igual de bien en el código
que en la revisión: `.bar` estaba declarada dos veces —la cabecera y la barra de
estimación de los grupos— y la segunda aplastaba la cabecera de 44 px a 4,
dejando el título medio fuera. Carga el `dist` en un WKWebView de 380x520, mide
las cajas y sale con error si alguna empieza por encima del panel o no mide lo
que debe.

**Nunca contra la base real.** `BITA_DB_PATH` apunta la app a una copia de la
bitácora, e `INKWELL_DB_PATH` con `INKWELL_DOCS_DIR` a una de inkwell:

```sh
cp ~/.local/share/bita/bita.db /tmp/bita-dev.db
cp ~/.local/share/inkwell/inkwell.db /tmp/inkwell-dev.db
cp -R ~/.local/share/inkwell/docs /tmp/inkwell-dev-docs
BITA_DB_PATH=/tmp/bita-dev.db INKWELL_DB_PATH=/tmp/inkwell-dev.db \
  INKWELL_DOCS_DIR=/tmp/inkwell-dev-docs pnpm tauri dev
```

| Variable | Para qué |
|---|---|
| `KIT_REGISTRY_DIR` | Leer otro registro de herramientas, por ejemplo uno de prueba |
| `BITA_CLI`, `INKWELL_CLI`, `TALLY_CLI`, `ATL_CLI`, `RECAP_CLI`, `GAZE_CLI` | Usar ese ejecutable o script en vez del registrado; un `.ts`/`.js` se corre con node |
| `BITA_DB_PATH` | Usar otra base de datos |
| `BITA_NODE` | Forzar un binario de node concreto para los scripts de las variables de arriba |
| `INKWELL_DB_PATH`, `INKWELL_DOCS_DIR` | Usar otra base o directorio de inkwell; también los vigila Den |
| `RECAP_STATE_DIR` | Leer el estado de recap (`active.json`, la reunión en curso) de otra carpeta; si no está, se usa `$XDG_STATE_HOME/recap` y luego `~/.local/state/recap` |
| `BITA_KEEP_PANEL` | Abre el panel al arrancar y evita que se esconda al perder el foco, para poder usar las devtools |
| `BITA_NO_OPEN_NOTES` | No abre la ventana de documentación al arrancar; deja solo el icono del tray |
| `BITA_KEEP_ACCESSORY` | No cambia la activation policy al abrir las notas: sin icono en el Dock ni barra de menús |
| `BITA_EDITOR` | Qué binario abre un `.md` en vez de dejárselo a `open` |

## Cómo habla con las herramientas

Un subproceso por consulta, siempre con `--json`, y una sola línea de stdout que
se parsea entera:

```json
{ "schemaVersion": 3, "ok": true, "command": "current", "data": [], "meta": {} }
```

El error se detecta por `ok: false`, nunca por el código de salida. stderr es
diagnóstico y se ignora. Con bita además se exige `schemaVersion` 3, que es el
modelo que entiende la app.

Cada subproceso arranca con el entorno limpio: `PATH` con la carpeta del
ejecutable registrado y las del sistema, `HOME`, el usuario, y solo las
variables `KIT_*`, `XDG_*`, `BITA_*`, `INKWELL_*`, `RECAP_*`, `ATL_*`, `TALLY_*` y
`GAZE_*`, más `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `SystemRoot`, `TEMP`,
`TMP`, `TMPDIR`, `LANG` y `PNPM_HOME`. Así las herramientas leen el mismo registro y las
mismas rutas que Den.

**El reloj no se le pide a bita.** Se lee `started_at` una vez y la cuenta la
lleva Rust contra el reloj de pared, que sobrevive a que el Mac se duerma. Tiene
que ser así de todas formas: macOS congela los timers de JavaScript cuando la
ventana está oculta, y el título de la barra tiene que seguir avanzando.

**Los subprocesos corren desde `/`.** Desde un repositorio git que no resuelve a
ningún proyecto, bita devuelve `REPO_NOT_MAPPED`; desde `/` no hay repo, así que
devuelve «sin proyecto» y el cronómetro en blanco es legal.

## Cómo se entera de los cambios

FSEvents vigila el **directorio** de la base de datos, no el fichero: en modo WAL
las escrituras van a `bita.db-wal`, que SQLite borra y recrea, y un watch clavado
a un inodo perdería su objetivo.

Los eventos por sí solos se retroalimentarían, porque las lecturas de la propia
app también mueven el directorio. Por eso cada tanda se contrasta con el `mtime`
y el tamaño de `bita.db`, y solo una diferencia real dispara un refresco. Medido
contra el CLI: abre y cierra la base una vez por comando, así que **una lectura
deja el fichero intacto y toda escritura hace checkpoint al cerrar y mueve el
`mtime`**.

Como red de seguridad hay además un sondeo cada treinta segundos, porque FSEvents
pierde eventos cuando el equipo se suspende.

Con inkwell instalado se vigilan también su base (`inkwell.db`) y su directorio
de documentos, con las mismas reglas.

Los `.md` necesitan su propio vigilante. El de la base mira `dirname(db)` sin
recursión y descarta toda tanda que no mueva el fingerprint de `bita.db`; los
documentos viven tres niveles más abajo, así que no llegaban eventos. El segundo
vigilante es recursivo sobre el directorio de documentos, con rebote de 400 ms y
filtrando a extensión `.md`. No hay bucle de realimentación: la app nunca escribe
un `.md`, solo los lee a través del subproceso del CLI, y leer no mueve el
`mtime`.

## La ventana de notas

El panel mide 380×520 y no es redimensionable, así que un documento de siete
secciones no cabe. Las notas viven en una ventana propia de 1280×820 (o el 90 %
de la pantalla, si es más chica), de solo lectura: escribir sigue siendo del
CLI, que es quien tiene el lock cooperativo, salvo marcar un pendiente como
resuelto.

El texto, las tablas y los diagramas comparten una sola columna, de 960 px por
defecto. El control de la barra del lector, o `cmd ]` y `cmd [`, la lleva de
560 px a todo el ancho; el doble clic la devuelve a 960. El árbol y el panel
lateral se redimensionan arrastrando su borde. Los tres anchos se recuerdan.

**Pendientes y hallazgos** es una vista propia, fija sobre el árbol: una
bandeja con el backlog de inkwell. A la izquierda, la lista con las pestañas
Hallazgos, Pendientes y Resueltos, un chip por proyecto para filtrar y un campo
que filtra por título o salta a un ítem por su clave (`STI-14`). A la derecha,
el detalle: la clave, que se copia con un clic, la línea `cierra STI-14` para
pedírselo a Claude, una nota de cómo se resolvió y los botones para resolver,
reabrir, convertir un hallazgo en pendiente o abrir su página
(`inkwell backlog resolve|reopen|edit`). El panel lateral de cada página enseña
sus ítems abiertos por clave, y los enlaces que se registraron para ella.

Se abre junto con la app, y `BITA_NO_OPEN_NOTES` lo suprime. Aun así se construye
desde Rust en vez de declararla en `tauri.conf.json`: una ventana declarada se
crea siempre, con lo que esa variable no podría evitarla, y el panel del tray
seguiría arrastrando un segundo webview en los arranques en los que no se quiere.
Al cerrarla se esconde en lugar de destruirse, así que reabrirla es inmediato.

Lleva su propio HTML (`notas.html`) y no una rama dentro de `index.html`, porque
`scripts/measure-panel.swift` carga `index.html` en un WKWebView pelado, sin IPC
de Tauri: una rama sobre `getCurrentWindow()` dejaría al test midiendo algo
indeterminado. Rollup comparte `dom`, `format` y `bita` entre los dos bundles.

Mientras está abierta, macOS pasa de `Accessory` a `Regular`. Sin eso la app no
tiene barra de menús —y por tanto no hay cmd+C nativo sobre una selección— ni se
puede recuperar la ventana con cmd+Tab. El menú son items predefinidos en
español, que es de donde salen cmd+W, cmd+C y cmd+A sin una línea de JavaScript.

El markdown se pinta con un renderizador propio de unas 250 líneas que construye
nodos con `element()`. No es por el peso: `marked` y `markdown-it` devuelven un
string de HTML, lo que obliga a `innerHTML` sobre contenido leído de ficheros, y
sanearlo bien exige una segunda dependencia. Construyendo nodos no hay nada que
escapar, porque el escapado es estructural. Lo que la gramática no reconoce se
emite como párrafo literal: nunca se pierde contenido. Las tablas GFM salen como
`<table>` de verdad por la misma vía, y cada celda pasa por el mismo paso en
línea, así que los enlaces y el resaltado de la búsqueda funcionan dentro.

## La ventana de reportes

El botón de la gráfica de barras, en la barra del panel entre las notas y los
ajustes, abre los reportes: el tiempo por proyecto en un rango, con gráficas y
exportación. Igual que las notas, el panel no tiene espacio para eso, así que
vive en una ventana propia (`reportes.html`) de 1280×820, o el 90 % de la
pantalla si es más chica, con un mínimo de 720×420.

Se construye desde Rust la primera vez que se pide, y no al arrancar. Un
segundo clic reutiliza la misma ventana y la trae al frente; al cerrarla se
esconde en lugar de destruirse. Mientras está abierta cuenta como ventana
normal, así que macOS pasa a `Regular` y aparece en el Dock y en cmd+Tab. El
botón solo aparece si el módulo de cronómetros (bita) está activo.

## La ventana del cerebro

El botón del grafo, junto a los reportes, abre el cerebro de los proyectos: lo
que `gaze` guarda (reglas, hechos, decisiones, documentos, entradas, tickets,
reuniones y memorias) dibujado como un grafo, al estilo de Obsidian. Es una
ventana propia (`cerebro.html`) que se construye y se esconde igual que la de
reportes, y el botón solo aparece si `gaze` está en el registro con
`memory.graph.read`.

Los datos salen de `gaze graph [--project P] --json`, `gaze show <id> --json` y
`gaze search <q> --project P|--all --json`. El dibujo es WebGL (sigma.js sobre
graphology), así que aguanta miles de nodos; ForceAtlas2 corre en un worker con
un número acotado de iteraciones y va moviendo los nodos mientras calcula. El
color es el tipo y el tamaño el grado. El selector cambia de proyecto (la lista
sale de los nodos), la leyenda apaga tipos y clases de conexión, pasar sobre un
nodo resalta a sus vecinos y un clic abre el panel lateral con el cuerpo en
Markdown (el mismo lector de las notas) y sus conexiones. La búsqueda llama a
`gaze search` y lleva la cámara al resultado.

Se dibuja como un cielo de constelaciones, siempre de noche: cada nodo es una
estrella con halo del color de su tipo sobre un campo de estrellas con paralaje,
y el titileo se apaga si el sistema pide reducir movimiento. Las estrellas se
pueden arrastrar y, al soltarlas, el grafo se reacomoda; en reposo flotan
despacio y se quedan quietas tras medio minuto sin mover el puntero, con la
ventana sin foco o si el sistema pide reducir movimiento.

Sin `gaze` instalado se puede revisar con datos de ejemplo
(`src/cerebro/fixture.json`), solo en desarrollo:

```sh
VITE_GAZE_FIXTURE=1 pnpm dev
```

y abrir `http://localhost:1420/cerebro.html`. La compilación de producción no
incluye el fixture.

## El tamaño del texto

`cmd +` y `cmd -` agrandan y encogen **el documento**, no la ventana: los
carriles conservan su densidad, que es donde se navega, y crece lo que se lee.
`cmd 0` vuelve a 1. Va de 0.8 a 2 y se recuerda en `localStorage`.

Es una variable CSS, `--doc-scale`, y las medidas del artículo son `em` sobre
ella. No es el zoom del webview a propósito: ese escalaría también el árbol y el
panel lateral, y entonces caben menos páginas en pantalla justo cuando querías
leer más cómodo.

## Los diagramas

Un cercado ` ```mermaid ` se dibuja con mermaid, que es **la única dependencia
que acaba dentro del bundle** además de `@tauri-apps/api`. Se carga con un
`import()` dinámico sólo cuando la página tiene uno, así que vive en un chunk
aparte y el arranque no lo paga: el bundle de la ventana pasa de 24 a 30 kB, y
el megabyte largo de mermaid sólo se descarga si hace falta.

`mermaid.render()` devuelve una **cadena** de SVG. No se inyecta con
`innerHTML`: se parsea con `DOMParser` en modo `image/svg+xml`, que es inerte, se
le quitan `script`, los atributos `on*` y cualquier `href` que no sea interno, y
se adopta el nodo. La regla de no usar `innerHTML` sigue en pie.

Mermaid 12 sigue escribiendo etiquetas HTML dentro de `foreignObject` en los
títulos de los subgrafos, y serializa sus saltos de línea como `<br>` sin
cerrar. Eso no es XML, y el parser lo rechaza aunque el diagrama compile. Cuando
pasa, el SVG se lee con el parser HTML, que lo deja en el namespace de SVG, y
pasa por el mismo saneado.

Los diagramas se dibujan **siempre en claro**, sobre una tarjeta blanca, aunque
la ventana sea oscura: los diagramas densos se leen mejor así, y es como los
enseña Confluence.

Va dentro de un `shadow root` porque los selectores de mermaid (`.node rect`,
`.edgePath path`) se filtrarían al CSS del lector. La CSP **no se toca**:
`style-src 'unsafe-inline'` ya estaba concedido, que es lo único que mermaid
necesita. `securityLevel: 'strict'` y `htmlLabels: false` cierran el resto, y
`theme: 'base'` es obligatorio y no preferencia, porque el tema por defecto ha
emitido `@import` de Google Fonts y aquí `font-src 'self'` lo bloquearía. La
paleta clara va entera en `themeVariables`, copiada de la del tema por defecto.

Al hacer clic sobre un diagrama se abre a pantalla completa: la rueda acerca y
aleja sobre el puntero, se arrastra para moverse, doble clic o `0` vuelve a
encajarlo, y `Esc` cierra. La copia que se muestra va en su propio shadow root,
igual que la incrustada, para que el `<style>` de Mermaid no se escape al
documento.

Los diagramas de draw.io llegan como un bloque ```` ```drawio ```` que nombra un
`.drawio` guardado en `<página>.assets/`. La app no los dibuja: enseña el PNG
que genera `inkwell diagrams render`, con el mismo lightbox. El PNG lo lee
Rust (`page_asset`, solo `.png` dentro de una carpeta `.assets` del directorio
de docs, hasta 10 MB) y lo pasa como `data:` URL, así que la CSP no cambia. Sin
render, la figura dice qué comando correr, y «Abrir en draw.io» abre el `.drawio`
para editarlo.

Un diagrama que no compila no puede tumbar el lector: cae al bloque de código
con el motivo. Hay tope de 20 KB de fuente y 20 diagramas por página.

## Dónde se coloca el panel

La vertical **no** sale del rectángulo del icono del tray, sale de
`NSScreen.visibleFrame`. La diferencia importa: en un MacBook con notch la barra
de menús mide 39 pt en vez de los 24 de siempre, y colocar el panel contando 24
lo mete media cabecera por debajo de la barra. `visibleFrame` es la única fuente
que sabe cuánto mide de verdad.

Del icono sale solo la horizontal, y va acotada a la pantalla para que un tray
pegado al borde derecho no empuje el panel fuera.

## Estructura

```
src/            el panel: TypeScript, sin framework
src/notes/      la ventana de notas: carril, lector, markdown
src-tauri/      el backend: tray, estado, registro, subprocesos, vigilancia
```

## Pruebas de contrato

`src-tauri/tests/cli_contract.rs` corre contra las herramientas que haya en un
registro de prueba, nunca contra el real: sin `KIT_REGISTRY_DIR` se saltan.
Cada herramienta registrada tiene que contestar `capabilities --json`, y bita,
inkwell, tally y atl además el contrato de datos que pinta la app, cada una con
su base en una carpeta temporal. La prueba de una herramienta que no está en el
registro se salta, igual que la de las notas de cada cronómetro si el inkwell
registrado no declara `docs.entry-notes`.

```sh
KIT_REGISTRY_DIR=/tmp/den-registry cargo test --test cli_contract
```

## Lo que falta

**El panel roba el foco al abrirse.** Es una ventana normal de Tauri, así que
mostrarla activa la app y la que estuvieras usando lo pierde. Lo correcto es un
`NSPanel` con el estilo `nonactivating`, que es lo que hace `tauri-nspanel`; la
migración es casi mecánica pero cambia cómo se muestra el panel, así que quedó
fuera hasta poder comprobarla a ojo.
