# Stencil — arrangement stencil plugin

Handoff brief from a Claude chat session. Personal-use tool for Tobi (producer, Logic Pro + FL Studio, Mac, Apple silicon).

## Goal
A JUCE plugin (AU for Logic Pro, VST3 for FL Studio, one codebase) that browses arrangement
stencils by genre and lets the user drag MIDI out into the DAW timeline:
- the full arrangement,
- one section (e.g. "Hook 1, 16 bars"),
- one instrument lane (e.g. "808" across the whole song).

"Stencil" is a placeholder name. Not confirmed by Tobi.

## What already exists in this folder
- `stencils/*.mid` — 20 stencils (5 each: Trap 140 BPM, R&B 80, Afrobeats 104, Rap 90).
  Type-1 MIDI: tempo, section markers, a SECTIONS GUIDE track, one track per instrument with a
  silent (velocity 1) placeholder note wherever that instrument plays.
- `stencils/manifest.json` — the same data as JSON (sections, bars, energy 1-10, active tracks
  per section). Use this as the plugin's embedded data source (BinaryData).
- `design/ui-mockup.dc.html` — static HTML mockup of the plugin window (980x640). Open in a
  browser for the layout; it references a `support.js` that is not included, so read the markup.
- `design/Arrangement_Maps.pdf` — one visual map per stencil.
- `tools/gen.py`, `tools/pdf.py` — the Python that generated the MIDI, manifest and PDF.
  Paths inside are from the original session; adjust before re-running.

## UI spec (from the mockup)
- Dark ground #15171C, borders #2A2E38, text #F2F4F8, muted text #A8AFBD.
- Section colors: hook/chorus #FF8A3D, verse #4DA3FF, intro/outro #7C8798,
  pre/build/post #F5C451, bridge/break/switch #B48CF2.
- Top bar: name, BPM / bars / length, "Drag full arrangement" button.
- Left panel (220px): genre list, then the stencils for the selected genre.
- Main: title + description, energy bars, draggable section chips (width proportional to bars),
  instrument lanes with a drag handle on each lane name.
- Footer: drag hint + color legend.
- Fonts in the mockup: Space Grotesk (headings), Inter (body).

## Technical notes
- Drag-out: write a temp .mid and start an external file drag
  (`DragAndDropContainer::performExternalDragDropOfFiles`). Verify the current JUCE API.
- A plugin cannot create host markers or tracks. Section names stay in the plugin UI.
- Tobi has built a JUCE/C++ AU plugin before (ChordChaos), so a JUCE toolchain may already be
  installed. Check before installing anything.
- Build options discussed: local build (Xcode or Command Line Tools + CMake) or GitHub Actions
  macOS runners. Tobi has not chosen yet.

## Not verified
- The MIDI files have not been imported into Logic or FL Studio yet. Marker import in FL is
  uncertain. Test one file in each DAW early.
- The structures are genre-standard layouts written by Claude, not mapped from specific songs.

## Open questions for Tobi
1. Plugin name.
2. Standalone plugin or a tab inside ChordChaos.
3. Whether to add a screen for mapping his own reference tracks.
4. Local build or GitHub Actions.
