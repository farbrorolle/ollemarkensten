# Brand Composer

Flerspårs Web-DAW-motor byggd med Vite, TypeScript och [Tone.js](https://tonejs.github.io/).
Tänkt som en Logic Pro-till-webben-bro: ladda WAV-stems bouncade i en viss BPM,
och spela upp dem 100% fassynkat i webbläsaren, med takt-synkade
sektionsövergångar, bussrouting, sidechain-ducking och en master-limiter som
garanterar att ljudet aldrig clippar.

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
    AudioEngine.ts        Tone.Transport, MasterBus -> Limiter -> speakers,
                           äger alla Track/Bus/Sidechain-instanser
    Bus.ts                Mixbuss (t.ex. DrumsBus, SynthBus): volym/pan/mute
                           + en insticksnod för sidechain-ducking
    Track.ts               Ett WAV-spår: Player -> sidechain-insticksnod ->
                           sektionsgrind (för övergångar) -> kanal (volym/pan/mute)
    Sidechain.ts           Envelope-follower-baserad ducking (threshold/ratio/
                           attack/release), realtidsjusterbar
    TransitionManager.ts   Schemalägger sektionsbyten till nästa hela takt
                           (Transport "+1m") utan att starta om några spår
  project/
    types.ts               ProjectConfig-typerna (bpm, tracks, buses,
                           sidechains, sections)
    loadProjectFromConfig.ts  Läser in ett projekt från ett config-objekt/JSON-fil
                           och sätter Tone.Transport.bpm därefter
  ui/                     Enkelt vanilla-TS test-UI (transport, mixerkanaler,
                           master-limiter-mätare, sidechain-reglage)
  main.ts                 Startpunkt: laddar public/config/demo-project.json
```

### Varför spåren håller sig fassynkade

Alla `Tone.Player`-instanser startas en gång, synkade mot `Tone.Transport`
(`player.sync().start(0)`), och körs sedan kontinuerligt genom hela
uppspelningen. En sektionsövergång stoppar eller startar aldrig om något
spår — den schemalägger bara en sample-exakt gain-automation
(`sectionGain`) på nästa taktgräns. Eftersom ingenting triggas om förblir
alla stems i fas, precis som när de bouncades tillsammans i Logic Pro.

### BPM och stems utan time-stretching

`Tone.Transport.bpm` sätts direkt från projektets metadata
(`loadProjectFromConfig`). Transportens taktgrid (och därmed alla
"+1m"-schemalagda övergångar) stämmer bara överens med ljudet om BPM matchar
den faktiska tempot stemsen bouncades i — det är därför ingen
time-stretching behövs: audiofilerna spelas upp i sin ursprungliga hastighet,
och transportens klocka räknar takter i samma tempo som ljudet redan har.
BPM-fältet i UI:t kan även ändras manuellt för snabba tester.

### Sidechain-ducking

Web Audio har ingen riktig sidechain-ingång på `DynamicsCompressorNode`, så
`Sidechain.ts` använder en `Tone.Meter` som envelope-follower på källspåret
och rampar målets gain-nod i realtid utifrån threshold/ratio (klassisk
kompressorformel) med separata attack-/release-ramptider.

## Demo-projekt

`public/config/demo-project.json` beskriver 8 spår (Kick, Snare, Hi-Hats,
Bass, Keys, Synth, Pad, FX) grupperade i DrumsBus/BassBus/SynthBus/FXBus, två
sidechains (Kick duckar BassBus och SynthBus) och två sektioner
(`verse`/`chorus`). De tillhörande WAV-filerna i `public/audio/` är
syntetiskt genererade loopar (120 BPM, 4 takter, fassynkade) via
`scripts/generate-demo-audio.mjs` — kör om skriptet för att regenerera dem.

Byt ut `public/config/demo-project.json` och `public/audio/*.wav` mot
riktiga stems exporterade från Logic Pro för att använda motorn på ett
riktigt projekt; `loadProjectFromConfig` kräver ingen annan kodändring.
