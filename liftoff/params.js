/* Liftoff parameters and presets, shared by the web page and the plugin.
   The plugin reads the two lists below as JSON (between the PARAMS / PRESETS markers), so keep them strict JSON:
   quoted keys, no comments and no trailing commas inside the brackets. */
var LIFTOFF_PARAMS = /*PARAMS*/[
  { "id": "mode",     "name": "Mode",            "type": "choice", "choices": ["Auto", "Manual", "Trigger"], "def": 0 },
  { "id": "phrase",   "name": "Phrase",          "type": "choice", "choices": ["4 bars", "8 bars", "16 bars", "32 bars"], "def": 2 },
  { "id": "length",   "name": "Build length",    "type": "choice", "choices": ["1/2 bar", "1 bar", "2 bars", "4 bars", "8 bars"], "def": 3 },
  { "id": "build",    "name": "Build",           "type": "float", "min": 0, "max": 1, "def": 0, "unit": "%" },
  { "id": "curve",    "name": "Curve",           "type": "float", "min": -1, "max": 1, "def": 0.35, "unit": "" },
  { "id": "rise",     "name": "Rise on",         "type": "bool", "def": 1 },
  { "id": "pitch",    "name": "Pitch",           "type": "float", "min": 0, "max": 24, "def": 7, "unit": "st" },
  { "id": "filter",   "name": "Filter",          "type": "float", "min": 0, "max": 1, "def": 0.6, "unit": "%" },
  { "id": "wash",     "name": "Wash",            "type": "float", "min": 0, "max": 1, "def": 0.5, "unit": "%" },
  { "id": "stutter",  "name": "Stutter",         "type": "float", "min": 0, "max": 1, "def": 0.3, "unit": "%" },
  { "id": "noise",    "name": "Noise",           "type": "float", "min": 0, "max": 1, "def": 0.35, "unit": "%" },
  { "id": "width",    "name": "Width",           "type": "float", "min": 0, "max": 1, "def": 0.5, "unit": "%" },
  { "id": "verb",     "name": "Backverb on",     "type": "bool", "def": 1 },
  { "id": "verbMode", "name": "Backverb mode",   "type": "choice", "choices": ["End", "Build", "Always"], "def": 0 },
  { "id": "verbLen",  "name": "Backverb length", "type": "choice", "choices": ["1/8", "1/4", "1/2", "1 bar"], "def": 2 },
  { "id": "verbSize", "name": "Backverb size",   "type": "float", "min": 0, "max": 1, "def": 0.5, "unit": "%" },
  { "id": "verbTone", "name": "Backverb tone",   "type": "float", "min": 0, "max": 1, "def": 0.6, "unit": "%" },
  { "id": "verbMix",  "name": "Backverb mix",    "type": "float", "min": 0, "max": 1, "def": 0.6, "unit": "%" },
  { "id": "trem",        "name": "Tremolo on",    "type": "bool", "def": 1 },
  { "id": "tremRate",    "name": "Tremolo rate",  "type": "choice", "choices": ["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"], "def": 1 },
  { "id": "tremDepth",   "name": "Tremolo depth", "type": "float", "min": 0, "max": 1, "def": 0.35, "unit": "%" },
  { "id": "tremShape",   "name": "Tremolo shape", "type": "choice", "choices": ["Sine", "Square", "Ramp", "Pan"], "def": 0 },
  { "id": "chorus",      "name": "Chorus on",     "type": "bool", "def": 1 },
  { "id": "chorusRate",  "name": "Chorus rate",   "type": "float", "min": 0.1, "max": 5, "def": 0.8, "unit": "Hz" },
  { "id": "chorusDepth", "name": "Chorus depth",  "type": "float", "min": 0, "max": 1, "def": 0.5, "unit": "%" },
  { "id": "chorusMix",   "name": "Chorus mix",    "type": "float", "min": 0, "max": 1, "def": 0.4, "unit": "%" },
  { "id": "mix",      "name": "Mix",             "type": "float", "min": 0, "max": 1, "def": 1, "unit": "%" },
  { "id": "output",   "name": "Output",          "type": "float", "min": -24, "max": 12, "def": 0, "unit": "dB" }
]/*END*/;

/* Presets set the sound: everything except the mode, the phrase, BUILD, MIX and OUTPUT. */
var LIFTOFF_PRESETS = /*PRESETS*/[
  { "name": "Liftoff", "tag": "The all-rounder: a 4 bar riser with chorus and a 1/8 tremolo, and a reverse swell into the end",
    "values": {"length": 3, "curve": 0.35, "rise": 1, "pitch": 7, "filter": 0.6, "wash": 0.5, "stutter": 0.3, "noise": 0.35, "width": 0.5, "verb": 1, "verbMode": 0, "verbLen": 2, "verbSize": 0.5, "verbTone": 0.6, "verbMix": 0.6, "trem": 1, "tremRate": 1, "tremDepth": 0.35, "tremShape": 0, "chorus": 1, "chorusRate": 0.8, "chorusDepth": 0.5, "chorusMix": 0.4} },
  { "name": "Festival Build", "tag": "Big room: an octave rise, a 1/16 square tremolo, white noise and a wide wash",
    "values": {"length": 3, "curve": 0.55, "rise": 1, "pitch": 12, "filter": 0.8, "wash": 0.7, "stutter": 0.75, "noise": 0.6, "width": 0.8, "verb": 1, "verbMode": 0, "verbLen": 2, "verbSize": 0.6, "verbTone": 0.7, "verbMix": 0.6, "trem": 1, "tremRate": 2, "tremDepth": 0.45, "tremShape": 1, "chorus": 1, "chorusRate": 0.6, "chorusDepth": 0.6, "chorusMix": 0.35} },
  { "name": "Trap Lift", "tag": "One bar of tension with a 1/32 tremolo shimmer",
    "values": {"length": 1, "curve": 0.2, "rise": 1, "pitch": 0, "filter": 0.45, "wash": 0.3, "stutter": 0, "noise": 0.12, "width": 0.3, "verb": 1, "verbMode": 0, "verbLen": 1, "verbSize": 0.4, "verbTone": 0.5, "verbMix": 0.5, "trem": 1, "tremRate": 4, "tremDepth": 0.4, "tremShape": 0, "chorus": 0, "chorusRate": 0.8, "chorusDepth": 0.5, "chorusMix": 0.4} },
  { "name": "Vocal Backverb", "tag": "Every phrase swells in backwards, with a light chorus",
    "values": {"length": 3, "curve": 0.35, "rise": 0, "pitch": 0, "filter": 0, "wash": 0, "stutter": 0, "noise": 0, "width": 0, "verb": 1, "verbMode": 2, "verbLen": 2, "verbSize": 0.6, "verbTone": 0.5, "verbMix": 0.7, "trem": 0, "tremRate": 1, "tremDepth": 0.3, "tremShape": 0, "chorus": 1, "chorusRate": 0.5, "chorusDepth": 0.4, "chorusMix": 0.3} },
  { "name": "Afro Swell", "tag": "A warm two-bar lift with a triplet auto-pan, for Afrobeats and Amapiano",
    "values": {"length": 2, "curve": 0.3, "rise": 1, "pitch": 3, "filter": 0.35, "wash": 0.6, "stutter": 0.15, "noise": 0.22, "width": 0.45, "verb": 1, "verbMode": 0, "verbLen": 1, "verbSize": 0.55, "verbTone": 0.45, "verbMix": 0.55, "trem": 1, "tremRate": 5, "tremDepth": 0.3, "tremShape": 3, "chorus": 1, "chorusRate": 0.9, "chorusDepth": 0.5, "chorusMix": 0.45} },
  { "name": "Chorus Bloom", "tag": "Dreamy: a deep slow chorus and a soft lift, for pads and vocals",
    "values": {"length": 3, "curve": 0, "rise": 1, "pitch": 0, "filter": 0.25, "wash": 0.6, "stutter": 0, "noise": 0.1, "width": 0.7, "verb": 1, "verbMode": 1, "verbLen": 2, "verbSize": 0.5, "verbTone": 0.6, "verbMix": 0.35, "trem": 0, "tremRate": 1, "tremDepth": 0.3, "tremShape": 0, "chorus": 1, "chorusRate": 0.3, "chorusDepth": 0.8, "chorusMix": 0.5} },
  { "name": "Washout", "tag": "Eight bars that dissolve into reverb, chorus and air",
    "values": {"length": 4, "curve": 0.6, "rise": 1, "pitch": 5, "filter": 0.9, "wash": 1, "stutter": 0, "noise": 0.5, "width": 1, "verb": 1, "verbMode": 1, "verbLen": 2, "verbSize": 0.8, "verbTone": 0.7, "verbMix": 0.5, "trem": 1, "tremRate": 0, "tremDepth": 0.25, "tremShape": 3, "chorus": 1, "chorusRate": 0.4, "chorusDepth": 0.8, "chorusMix": 0.6} },
  { "name": "Stutter Riser", "tag": "Gated 1/4 to 1/32 notes climbing an octave, chopped harder by a 1/32 square tremolo",
    "values": {"length": 2, "curve": 0.4, "rise": 1, "pitch": 12, "filter": 0.6, "wash": 0.3, "stutter": 1, "noise": 0.4, "width": 0.6, "verb": 0, "verbMode": 0, "verbLen": 1, "verbSize": 0.5, "verbTone": 0.6, "verbMix": 0.5, "trem": 1, "tremRate": 3, "tremDepth": 0.6, "tremShape": 1, "chorus": 0, "chorusRate": 0.8, "chorusDepth": 0.5, "chorusMix": 0.4} },
  { "name": "Reverse Into The 1", "tag": "Just the sound and a reverse swell from its first hit, landing where the drop goes",
    "values": {"length": 1, "curve": 0.35, "rise": 0, "pitch": 0, "filter": 0, "wash": 0, "stutter": 0, "noise": 0, "width": 0, "verb": 1, "verbMode": 0, "verbLen": 2, "verbSize": 0.7, "verbTone": 0.65, "verbMix": 0.9, "trem": 0, "tremRate": 1, "tremDepth": 0.3, "tremShape": 0, "chorus": 1, "chorusRate": 0.7, "chorusDepth": 0.5, "chorusMix": 0.35} },
  { "name": "Subtle Lift", "tag": "Mix-friendly: a gentle filter, light chorus and tremolo, reverse swells that grow with the build",
    "values": {"length": 3, "curve": 0.3, "rise": 1, "pitch": 0, "filter": 0.3, "wash": 0.25, "stutter": 0, "noise": 0.12, "width": 0.3, "verb": 1, "verbMode": 1, "verbLen": 1, "verbSize": 0.4, "verbTone": 0.5, "verbMix": 0.3, "trem": 1, "tremRate": 1, "tremDepth": 0.15, "tremShape": 0, "chorus": 1, "chorusRate": 0.5, "chorusDepth": 0.3, "chorusMix": 0.25} }
]/*END*/;
