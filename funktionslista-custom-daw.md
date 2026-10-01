# Custom DAW – funktionslista inför nya designen (2026-10-01)

Ingen funktion i listan får försvinna när designen 2a byggs in (2a Workspace plus aha-overlayn och turen från 2c). Kolumnen "I 2a" säger var funktionen hamnar. **Ny** = finns i designen men inte i appen än.

## Kundvy – grund (steg 1 Fit the length)
| Funktion | I dag | I 2a |
|---|---|---|
| Lägga in film (dra fil, Choose film…) | Filmpanel | Tomt filmfält under tidslinjen, |
| Replace / Remove film | Filmpanel | Filmetiketten nere till vänster på filmen |
| Klippsökning, loggan på slutskylten | Automatisk | Oförändrad; "End card" i filmljudspåret |
| ◀ Previous cut / Next cut ▶ | Vyraden | Högerpanel "Logo lands on" |
| Logo on/off (+ Logo) | Vyraden / palett | Högerpanel under "Logo lands on" |
| Dra loggans gröna linje | Tidslinjen | Oförändrad |
| Dra musikens högra kant | Tidslinjen | Oförändrad (violett handtag) |
| Musikens startpunkt i filmen | Tidslinjen | Oförändrad |
| Längdval Original / 60 / 30 / 15 s / Custom | – | Högerpanel "Length" (**ny**) |
| Auto arrange / Original form | Verktygsrad | Högerpanel "When the length changes" (texterna rättas) |
| Include all parts | Verktygsrad | "Use every part of the track" (alltid synlig, aktiv med Auto arrange) |
| Lock to video length | Verktygsrad | "Keep the film's length" |
| Reset to original form / Reset to film length | Verktygsrad | Högerpanel, diskret länkrad |
| Undo / Redo (+ ⌘Z, ⇧⌘Z) | Verktygsrad | Ikonknappar vid tidslinjen |
| Aha-besked efter anpassning, "Play the ending" | Liten grön etikett | Grönt kort plus overlay på filmen (2c) |
| Guidad tur, 3–4 steg | – | **Ny** (2c) |

## Transport och lyssning
| Funktion | I dag | I 2a |
|---|---|---|
| Play/Pause (en knapp, klick på filmen) | Transport + film | En stor Play under filmen |
| ⏮ Home, ⏪ −5 s, ⏩ +5 s, ⏹ Stop | Transport | Små ikonknappar bredvid Play |
| Tangentbord: Space, ←/→, Home | Ja | Oförändrat |
| Tid och aktuell del (t.ex. "Main motif") | Filmoverlay/transport | Tidsrad bredvid Play |
| Film audio on/off och fader (mute i botten) | Filmpanel | "Film audio on" plus reglage i Levels |
| Music-fader (mute i botten) | Filmpanel | Levels: "Music" |
| Limiter gain | Filmpanel | Levels: "Loudness boost" |
| Master-strip: peak L/R med 0 dB, GR, LUFS M/S/I | Filmpanel | Levels, under Loudness boost (saknas i designen) |
| Limiter On och Ceiling (bara skaparvyn) | Filmpanel | Skaparvyn |

## Fine-tune: delar och form
| Funktion | I dag | I 2a |
|---|---|---|
| Delkort (7 delar, färger) – dra in, klick lägger sist | Palett | Högerpanel "Parts of the track", med status (4 of 8 / not used) |
| Infoga med längdmeny (Shorter / Original / Longer) | Släpp nära kant | Oförändrat |
| Ersätta del: släpp kort mitt på en del | Ja (ny i dag) | Oförändrat |
| Flytta del (dra block) | Formfält | Oförändrat |
| Ändra längd (dra kant, äter till höger) | Formfält | Oförändrat |
| Ta bort del (dra bort / × / menyn) | Formfält | Oförändrat |
| Delmeny: crossfade av/på, instrument som klipps, Delete section | Klick på block | Oförändrat (popover i designens stil) |
| ↻ loopar och ✂ förkortade delar | Formfält | Ikoner enligt designen |
| Layers: Melody, Small swell, Big swell (dra till del) | Palett LAYERS | Högerpanel "Layers" |
| Swells-spår: auto, lägg till, ta bort, startswell | Swells-spår | Oförändrat (krysset får plats) |
| Zoom (−, reglage, +, Fit) och taktlinjer | Vyraden | Zoomreglage plus Fit vid tidslinjen |

## Fine-tune: nivåer
| Funktion | I dag | I 2a |
|---|---|---|
| En fader per mapp (projektets mappar, som exporterade) | Mixer | Levels-flik "Folders", alltid synlig – inga egna grupper |
| Volume cues per instrument (klick på spåret, förval, "only in this part", dra) | Spåret Volume cues | Oförändrat |
| Music volume-spår (hela musiken) | Ja (ny i dag) | Eget spår under Volume cues |
| Levels per part: Set, Copy, Paste, Apply to all parts, Clear part | Spårlistan | Levels-flik: "Levels for this part" |

## Export
| Funktion | I dag | I 2a |
|---|---|---|
| Export Music (WAV, 24-bit, linjerad mot filmens start) | Transportpanel | Export-meny |
| Export Film with music (bilden kopieras, AAC eller Vorbis) | Transportpanel | Export-meny, primär, förlopp i menyn (format = filmens eget) |

## Skaparvyn (behåller allt, får bara den nya stilen)
Följande finns kvar som i dag:
- Master: kompressor, musiklimiter, LUFS och Export stereo WAV.
- Sidechain-panelen: källa, mål, ducking, solo.
- Logo-panelen: fade in i loggan, slag på taktslag, tystnad före slaget.
- Pan, solo och ladda egna ljudfiler per spår.
- BPM/Bar:Beat-fält, limiterns On och Ceiling.
- Växla mellan kund- och skaparvy.

## Senare (ej i designbygget)
Snabb offline-export, spara/öppna projekt, flytta enskilda spår per del, import av markörer.
