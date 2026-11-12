# Circles&Triangles

Clone locale e senza limiti di html.to.design: catturi un sito dal browser e lo importi in Figma come layer modificabili (auto layout, font, testi con stili misti, immagini, video, SVG, gradienti, ombre, bordi, raggi, blend mode, rotazioni, sticky/fixed).

- `extension/`: estensione Chrome e Firefox che legge DOM e stili calcolati della pagina aperta
- `figma-plugin/`: plugin Figma che ricostruisce i layer
- `tools/fonts.sh`: scarica i font del sito e li installa sul Mac

## Installazione

**Estensione Chrome**
1. Apri `chrome://extensions`, attiva *Modalità sviluppatore*
2. *Carica estensione non pacchettizzata* → cartella `extension/` (dopo ogni aggiornamento: icona ↻ sull'estensione)

**Estensione Firefox** (la stessa cartella, Firefox 128+)
1. Apri `about:debugging#/runtime/this-firefox` → *Carica componente aggiuntivo temporaneo…* → scegli `extension/manifest.json`
2. Al primo click su un bottone, Firefox chiede il permesso di accedere ai siti: concedilo (serve per scaricare immagini, video e font)
3. I componenti temporanei spariscono alla chiusura di Firefox. Per tenerla installata: firmala gratis come "non in elenco" su addons.mozilla.org, oppure usa Firefox Developer Edition con `xpinstall.signatures.required` = `false` in `about:config` e installa lo zip creato da `npx web-ext build -s extension`

**Plugin Figma** (serve l'app desktop di Figma)
1. Figma → *Plugins → Development → Import plugin from manifest…*
2. Scegli `figma-plugin/manifest.json`

## Uso

1. Apri il sito in Chrome o Firefox. Nell'estensione scegli la **larghezza pagina** (1728 px di default, oppure 1440, 1920, 1280, 390 mobile o finestra attuale): la finestra viene ridimensionata per la cattura e poi ripristinata. Con tre check scegli cosa rendere interattivo: **caroselli**, **hover** sulle immagini, **animazioni continue** (togli la spunta per averli statici). Chiudi i banner dei cookie.
2. Icona dell'estensione → **Cattura e copia**, oppure **Cattura e scarica .json** (consigliato per pagine pesanti, con video, o se vuoi installare i font).
3. In Figma: *Plugins → Development → Circles&Triangles* → **⌘V** nella finestra del plugin (o trascina il .json).
4. Se il sito usa font che non hai, il plugin te li elenca prima di importare. Per ognuno scegli:
   - **Immagine dal sito**: il testo arriva identico, come immagine ritagliata dalla pagina, con il testo vero in un livello nascosto sotto (serve l'opzione *Testi anche come immagine* nell'estensione, attiva di default)
   - un font installato: in cima trovi i più simili (misurati da `fonts.sh`, altrimenti dello stesso genere). Sotto vedi una riga del sito e la stessa riga col font scelto, con una tendina del **peso** (già sul più vicino a quello del sito; gli altri pesi dello stesso font si spostano di quanto lo sposti tu) e una della dimensione in px già impostata sulla misura che occupa la stessa larghezza: la proporzione vale per tutti i testi in quel font
   - ↗ accanto al nome apre dove scaricarlo (Google Fonts se è un Google Font, altrimenti una ricerca)

   La scelta viene ricordata.

## Font del sito in locale

Per avere i font veri, presi dal sito e modificabili in Figma: doppio clic su **`tools/Installa font.command`** (usa l'ultima cattura in Download), oppure:

```bash
tools/fonts.sh ~/Downloads/h2f-sito.com-1440px.json
```

Lo script scarica i file `@font-face`, li converte da woff/woff2 a OTF/TTF, li installa in `~/Library/Fonts` (ne lascia una copia in una cartella `…-fonts` accanto al .json) e scrive nel .json quale font reale corrisponde a ogni alias del CSS (es. `sans bold` → *PP Neue Montreal Bold*). Confronta anche le misure di ogni font del sito (larghezza delle lettere, altezza x/maiuscole, peso, grazie, mono) con tutti i font del Mac e scrive i 5 più simili, che il plugin propone per primi. Riavvia Figma e reimporta lo stesso .json. Con `--no-install` li salva soltanto (e calcola comunque i simili).

La prima esecuzione prepara un ambiente Python con fontTools (serve internet). Attenzione: molte licenze webfont non permettono l'uso desktop.

## Cosa fa la cattura

- **Pagina intera** anche sui siti che scorrono dentro un `div` (body bloccato), con autoscroll per caricare immagini lazy.
- **Animazioni**: durante l'autoscroll aspetta che le animazioni di ogni blocco finiscano (fino a 1,5 s), ricorda lo stato in cui ogni elemento era visibile (fade-in, righe che salgono da una maschera) e prima della cattura porta a fine corsa animazioni CSS, reveal GSAP non legati allo scroll e AOS.
- **Ordine dei livelli** come lo disegna il browser (`z-index`, elementi posizionati).
- **Fixed e sticky**: gli elementi `position: fixed` diventano fissi nel prototipo. Gli `sticky` (letti dal CSS) restano al loro posto con la stessa struttura del sito e in Figma si fermano alla fine del loro contenitore come nel CSS, sopra a tutto il resto (a qualunque profondità siano annidati; se il contenitore è in auto layout lo perde, perché nel prototipo uno sticky in posizione assoluta non si attacca): la striscia sopra un header scorre via e l'header sale a top 0. Figma attacca solo al bordo alto e senza distanza: le barre in basso (`fixed` con `bottom`, o `sticky` in basso dentro un contenitore lungo quasi tutta la pagina) restano attaccate al fondo dello schermo (vincolo *Bottom*), gli altri sticky in basso diventano elementi normali, quelli con `top: 100px` si attaccano a 0. L'API dei plugin non sa impostare *Sticky*, quindi la **prima volta in un file** il plugin li lascia selezionati: *Prototype → Scroll behavior → Position → Sticky*. Dall'import successivo nello stesso file usa uno di quelli come modello (nascosto, «modello sticky (non cancellare)») e li imposta da solo. La tavola scorre solo in verticale; nel prototipo usa *Fit width* se è più larga della finestra.
- **Scorrimento orizzontale**: l'estensione prova davvero a far scorrere ogni contenitore più largo dello schermo (`overflow-x: auto/scroll`, scroll-snap); se scorre, in Figma diventa un frame che scorre in orizzontale e nel prototipo si sposta col trackpad come sul sito.
- **Caroselli automatici**: l'estensione osserva i caroselli per 8 secondi senza toccarli; se avanzano da soli misura l'intervallo e in Figma ogni variante passa alla successiva dopo lo stesso tempo (anche i caroselli senza frecce).
- **Animazioni continue** (CSS/Web Animations infinite: scritte che scorrono, icone che ruotano, pulsazioni): catturate al primo fotogramma e rifatte con Figma Motion (traslazione, rotazione, scala, opacità, stesse durate ed easing, anche `alternate`). Nel prototipo partono da sole e si ripetono. Le dissolvenze fino a invisibile (fade-in/out, anche quelle allo scroll o al caricamento delle immagini) non si rifanno: l'elemento è subito visibile. Le proprietà CSS separate `translate`/`scale` non sono lette, solo `transform`, `rotate` e `opacity`.
- **Link interni** (`href="#sezione"`): in Figma un clic scorre fino alla sezione.
- **Avviso a fine cattura**: messaggio nella pagina e ✓ verde sull'icona dell'estensione (rosso con ! se c'è un errore).
- **Caroselli e hover interattivi**: i caroselli (ARIA `aria-roledescription="carousel"`, Swiper, Slick, Splide, Glide, Owl, Bootstrap, o riconosciuti da frecce avanti/indietro) vengono fatti scorrere e ogni stato diventa una variante di un componente Figma; frecce, miniature e trascinamento cambiano variante con Smart Animate. Se le miniature comandano un'immagine grande (`aria-controls`), il componente include anche quella. Gli hover sulle immagini definiti nel CSS (`:hover`) diventano una variante *Hover* con interazione *While hovering*. I set di componenti sono a destra della tavola, nella pagina c'è un'istanza. Le card con la stessa struttura e la stessa misura usano **un solo componente** (Default/Hover): ogni card è un'istanza con le sue foto e i suoi testi come override. Funzionano anche gli hover fatti con `::before/::after` (es. Farfetch: seconda foto come sfondo dell'`::after`) e quelli dentro un carosello (componenti annidati). Hover fatti solo in JavaScript non vengono rilevati.
- **Banner dei cookie** più diffusi (iubenda, Cookiebot, OneTrust, Didomi…) esclusi dalla cattura.
- **Testi con effetti che Figma non sa rifare** (assi variabili come `SCAN`, corsivo simulato su font senza italic, skew, contorno, testo con sfumatura): importati come immagine presa dal sito, con il testo vero nascosto sotto. Si disattiva dal plugin. L'ombra del testo diventa un'ombra Figma.
- **Video**: importati come video veri (MP4/WebM/MOV fino a 100MB; i video in Figma richiedono un piano a pagamento), con poster/frame come fallback. Stream HLS/blob restano immagine. Nel prototipo (Present ▶) partono da soli; se un video non è stato importato, il plugin dice perché a fine import.
- Nessun link applicato ai testi.

## Come funziona l'auto layout

Per ogni contenitore il plugin legge la geometria reale dei figli e prova orizzontale / verticale / a capo (wrap). Lo applica solo se padding, spaziatura e allineamenti riproducono le posizioni esatte (tolleranza 2px); altrimenti quel livello resta libero, così la grafica non si rompe. In verticale, se le distanze tra i blocchi sono diverse (margini diversi nel sito), mette spaziatura 0 e tra i blocchi dei frame trasparenti «spazio» alti quanto il margine: come nell'HTML, se un testo cresce (es. font sostituto più grande) quello che sta sotto scende. Gli elementi `absolute/fixed` e ruotati diventano figli in posizione assoluta.

## Limiti noti

- Scene "pinned" guidate dallo scroll (es. slideshow che cambiano scorrendo): viene catturato un solo stato
- `::before/::after`: importati solo se posizionati (absolute) con sfondo, immagine o bordo; il loro testo sì; icone fatte con font o `content: url()` no
- `mask-image`, `clip-path`, `text-shadow`, filtri diversi da blur/grayscale ignorati
- z-index tra rami diversi dell'albero: l'ordine è rispettato solo tra fratelli
- Niente incolla diretto sul canvas: il formato appunti di Figma è proprietario, si passa dal plugin

## Test

```bash
node test/mock-figma.mjs
```

Esegue il plugin contro un finto oggetto `figma` con `test/fixture.json` (o un JSON passato come argomento).
