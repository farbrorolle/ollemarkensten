# Brand Composer

Flerspårs Web-DAW-motor byggd med Vite, TypeScript och [Tone.js](https://tonejs.github.io/).
Tänkt som en Logic Pro-till-webben-bro: ladda WAV-stems bouncade i en viss BPM,
och spela upp dem 100% fassynkat i webbläsaren, arrangerade i fasta sektioner
(Verse/Chorus/...) på en tidslinje, med bussrouting, sidechain-ducking och en
master-limiter som garanterar att ljudet aldrig clippar.

## Köra lokalt

```bash
npm install
npm run dev       # dev-server med HMR
npm run build     # tsc typkontroll + produktionsbygge till dist/
npm run preview   # servera produktionsbygget lokalt
```

Öppna appen och klicka **Play** (webbläsaren kräver en användarinteraktion
innan `AudioContext` får starta).

## Arkitektur

```
src/
  audio/
    AudioEngine.ts          Tone.Transport, MasterBus -> Limiter -> speakers,
                             äger alla Track/Bus/Sidechain-instanser
    Bus.ts                  Mixbuss (t.ex. DrumsBus, SynthBus): volym/pan/mute
                             + en insticksnod för sidechain-ducking
    Track.ts                 Ett logiskt spår (t.ex. "Bass"): antingen en enda
                             loopande Player (samma ljud i alla sektioner den
                             är med i) eller en Player per sektion (olika
                             ljudfil per sektion, samma spårnamn/mixerkanal)
    ArrangementManager.ts   Schemalägger hela arrangemanget en gång vid
                             inläsning: fasta cue-punkter (takt -> sektion,
                             + övergångstyp), inga live-triggade övergångar
    TransitionFx.ts          Delade synthesnoder för övergångstyperna
                             "filter-sweep" och "riser" (masterfilter +
                             brus-riser), triggas av ArrangementManager
    Sidechain.ts            Envelope-follower-baserad ducking (threshold/ratio/
                             attack/release), realtidsjusterbar
    wav.ts                  WAV-encoding + nedladdning för stereo-export
  project/
    types.ts                 ProjectConfig-typerna (bpm, tracks, buses,
                             sidechains, sections, arrangement, transition)
    loadProjectFromConfig.ts  Läser in ett projekt från ett config-objekt/JSON-fil
                             och sätter Tone.Transport.bpm därefter
  ui/                       Enkelt vanilla-TS test-UI: transport, redigerbar
                             tidslinje (arrangemang + waveforms), mixerkanaler,
                             master-limiter-mätare + export, sidechain-reglage
  main.ts                   Startpunkt: laddar public/config/demo-project.json
```

### Arrangemang: fasta cue-punkter, inte en live-knapp

Sektionsbyten är inte något man triggar för hand under uppspelning — de är
en del av arrangemanget, precis som i en vanlig DAW. En `ProjectConfig` har
en `arrangement`-lista: `[{bar: 1, section: "verse"}, {bar: 9, section:
"chorus"}]`, plus `loopBars` för hur långt hela arrangemanget är innan det
loopar. `ArrangementManager.schedule()` läser den listan **en gång**, när
projektet laddas, och sätter upp `Tone.Transport`s loop-punkter samt alla
cue-händelser direkt — ingenting väntar på en knapptryckning. Vill du ändra
var sektionerna byter, redigerar du `arrangement`, inte kod.

Ett spår kan vara med i flera sektioner på två sätt:
- **Samma ljud, på/av** (`TrackConfig.file` + `SectionConfig.activeTracks`):
  spåret loopar kontinuerligt hela låten, och en sample-exakt gain-automation
  (`sectionGain`) tystar/spelar det beroende på vilken sektion som är aktiv.
- **Olika ljud per sektion, samma spårnamn** (`TrackConfig.sections`, en
  karta sektion-id -> filväg): spåret får en egen `Tone.Player` per sektion,
  och bara den aktiva sektionens spelare är igång — startas/stoppas exakt på
  sin taktgräns, med en kort klickfri urblandning (`takeGain`). Demots
  `bass`-spår använder detta: `bass_verse.wav` i versen, `bass_chorus.wav`
  (en piggare åttondelspumpande basgång) i refrängen, samma mixerkanal.

### Redigera arrangemanget i tidslinjen

Tidslinjen är inte bara en visualisering — sektionsblocken går att redigera
direkt, drag-and-drop:
- **Dra ett block** för att flytta det till en annan plats i arrangemanget.
- **Dra högerkanten** på ett block för att ändra dess längd i takter.
- **× i hörnet** tar bort en sektion (minst en måste finnas kvar).
- **Chips** ovanför tidslinjen lägger till en ny instans av valfri sektionstyp
  i slutet.

Varje ändring bygger om cue-listan från blockens aktuella ordning/längder och
skickar den direkt till `AudioEngine.applyArrangement()` — ingen separat
"spara". Den metoden är säker att anropa upprepade gånger: den stoppar
transporten (spolar till takt 1), rensar all schemalagd cue/gain-automation,
och synkar om varje sektionerat spårs per-sektion-spelare
(`Track.resyncSectionTakes` — unsync+sync rensar en `Player`s inspelade
start/stopp-tillstånd) innan det nya arrangemanget schemaläggs, så upprepade
redigeringar aldrig lämnar kvar gammal automation eller dubbelschemalagda
spelare.

### Övergångar mellan sektioner

Varje cue (utom arrangemangets första) har en övergångstyp, redigerbar via en
liten meny i sektionsblocket i tidslinjen:

- **Cut** — nästan momentant byte, ingen hörbar toning.
- **Crossfade** (standard) — kort musikalisk toning (en åttondel) mellan
  utgående/inkommande.
- **Filter sweep** — som crossfade, plus att master-lowpass-filtret sveper
  igen en takt innan cuen och poppar upp igen exakt på den.
- **Riser** — som crossfade, plus ett syntetiskt brus-riser (`Tone.Noise` +
  bandpass-filter) som bygger upp och kulminerar exakt på cuen.

Cut/crossfade avgör bara hur långa de befintliga gain-rampningarna
(`sectionGain`/`takeGain`) är — samma schemaläggningskod som redan fanns.
Filter sweep/riser lägger till ett extra, återanvändbart effektlager
(`TransitionFx`) ovanpå det, inkopplat i masterkedjan (`masterBus -> filter
-> limiter`) respektive mixat in i master-kanalen.

### Varför spåren håller sig fassynkade

Alla `Tone.Player`-instanser startas synkade mot `Tone.Transport`
(`.sync()`), som schemaläggs en gång vid inläsning och sedan repeteras
korrekt varje varv — det är själva poängen med `Source.sync()` i Tone.js:
en synkad källas start/stopp-tillstånd spelas upp igen automatiskt vid
`Transport`s "loopStart"/"loopEnd"-händelser. Inget spår startas om i
farten under en sektionsövergång; antingen loopar det kontinuerligt (på/av
via `sectionGain`) eller så är det redan schemalagt att starta exakt på sin
taktgräns (sektionerad `Player`). Eftersom ingenting triggas ad-hoc förblir
alla stems i fas, precis som när de bouncades tillsammans i Logic Pro.

### BPM och stems utan time-stretching

`Tone.Transport.bpm` sätts direkt från projektets metadata
(`loadProjectFromConfig`). Transportens taktgrid (och därmed alla
cue-punkter i `arrangement`) stämmer bara överens med ljudet om BPM matchar
den faktiska tempot stemsen bouncades i — det är därför ingen
time-stretching behövs: audiofilerna spelas upp i sin ursprungliga hastighet,
och transportens klocka räknar takter i samma tempo som ljudet redan har.
BPM-fältet i UI:t kan även ändras manuellt för snabba tester; alla
taktbaserade cue-punkter räknas om automatiskt eftersom de uttrycks i takter,
inte sekunder.

### Sidechain-ducking

Web Audio har ingen riktig sidechain-ingång på `DynamicsCompressorNode`, så
`Sidechain.ts` använder en `Tone.Meter` som envelope-follower på källspåret
och rampar målets gain-nod i realtid utifrån threshold/ratio (klassisk
kompressorformel) med separata attack-/release-ramptider.

### Exportera till stereo-WAV

**Exportera stereo-WAV**-knappen i Master Chain-panelen bouncar hela mixen —
precis som den låter just nu (volym/pan/mute/solo, lokalt utbytta filer,
sidechain, övergångar, allt) — till en nedladdningsbar 44.1kHz/16-bit
stereo-WAV, en hel loop från takt 1.

Det här är en **realtidsinspelning**, inte ett offline-render: `Tone.Recorder`
(byggd på `MediaRecorder`) tappar av master-utgången medan arrangemanget
faktiskt spelas upp, och exporten tar därför lika lång tid som låten är. Det
är ett medvetet val — sidechain-duckningen bygger på `Tone.Meter`/
`AnalyserNode`, som bara ger meningsfulla värden mot en live `AudioContext`;
ett offline-render (`Tone.Offline`) hade tystat duckningen helt. Efter
inspelningen avkodas den (webm/opus) och skrivs om till en ren WAV-fil
(`src/audio/wav.ts`) för maximal kompatibilitet med andra DAW:ar.

## Demo-projekt

`public/config/demo-project.json` beskriver 8 spår (Kick, Snare, Hi-Hats,
Bass, Keys, Synth, Pad, FX) grupperade i DrumsBus/BassBus/SynthBus/FXBus, två
sidechains (Kick duckar BassBus och SynthBus) och ett 16-takters arrangemang:
takt 1 = Verse (Kick/Snare/Hi-Hats/Bass/Keys), takt 9 = Chorus (samma plus
Synth/Pad/FX). `Bass` är det sektionerade exemplet — lugn hållen basgång i
versen, piggare åttondelspumpande basgång i refrängen, samma spårnamn och
mixerkanal.

De tillhörande WAV-filerna i `public/audio/` är syntetiskt genererade loopar
(120 BPM, 4 takter, fassynkade) via `scripts/generate-demo-audio.mjs` — kör
om skriptet för att regenerera dem.

Byt ut `public/config/demo-project.json` och `public/audio/*.wav` mot
riktiga stems exporterade från Logic Pro för att använda motorn på ett
riktigt projekt; `loadProjectFromConfig` kräver ingen annan kodändring.

### Testa egna filer utan hosting

Varje icke-sektionerat spår i test-UI:t har en 📁-knapp (och tar emot
drag-and-drop) för att ersätta dess ljud med en lokal fil direkt från din
dator (`Track.loadFromFile`, via `URL.createObjectURL` — filen lämnar
aldrig webbläsaren och försvinner när fliken stängs). Bra för att snabbt
lyssna på riktiga stems utan att ladda upp dem någonstans först.

## Extern lagring för riktiga stems (Supabase Storage)

`file` i `ProjectConfig` är bara en URL, så motorn bryr sig inte om en stem
ligger lokalt i `public/audio/` eller på en extern server. Riktiga Logic
Pro-stems (ofta 30–50MB/spår) hör inte hemma i git-repot — GitHub har en
hård gräns på 100MB per fil och repot blir snabbt segt att klona.

Ett Supabase Storage-projekt (`OlleMan`, ref `oztzxrxfwvvccrqzhiry`) är
redan förberett med en publik bucket `stems` (public read-policy skapad).
`public/config/demo-project.supabase.json` är samma demoprojekt fast med
stems-URL:er som pekar dit — öppna appen med `?config=supabase` i URL:en
för att testa den varianten.

Så lägger du in riktiga låtar:
1. Ladda upp WAV-filerna via Supabase-dashboarden → projektet "OlleMan" →
   **Storage → stems** (drag-and-drop). Den här sandlådans nätverkspolicy
   tillåter inte att jag laddar upp filer dit programmatiskt, så det steget
   görs manuellt i dashboarden.
2. Filens publika URL blir
   `https://oztzxrxfwvvccrqzhiry.supabase.co/storage/v1/object/public/stems/<filnamn>.wav`
3. Peka `file` (eller `sections`, för ett spår med olika ljud per sektion) i
   en ny `ProjectConfig`/JSON på den URL:en. Klart.
