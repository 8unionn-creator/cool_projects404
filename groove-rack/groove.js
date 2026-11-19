/* Groove Rack — genre-aware pattern generator.
   Each genre has a vocabulary of real patterns per role (kick, snare, hats, percussion, bass rhythm).
   A new pattern starts from one of them and varies it: anchors (X) such as the backbeat never move,
   other hits can drop or move, new hits favour the strong steps, the last bar of the loop gets a fill,
   and the bass locks to the kick or plays the genre's bass rhythm over the style's chord progression.
   Each genre has styles with their own tempo, patterns, feel (timing and accents per part), chords and bass phrases.
   Loops are built as phrases (A A A' A+fill), and what you teach it (MIDI loops, likes) is mixed in.
   Pattern strings use the same characters as presets.js: X anchor, x hit, o ghost, r/t/q roll, - rest. */
(function () {
'use strict';
const GR = window.GR, TPB = GR.TPB;

const ROLE = { kick: 'kick', snare: 'snare', clap: 'snare', snap: 'snare', rim: 'rim', hat: 'hat', openhat: 'openhat', cymbal: 'cymbal',
  tom: 'tom', shaker: 'shaker', conga: 'conga', bell: 'bell', block: 'block', fx: 'fx' };
GR.roleOf = tr => (GR.INST[tr.inst].pitched ? 'bass' : (ROLE[tr.inst] || 'perc'));

const FOUR = ['X---X---X---X---'];
const BACK = ['----X-------X---', '----X-------X--x', '----X--x----X---'];
// bass phrases: [step, length in steps, degree above the chord root (2 third, 4 fifth, 6 seventh, 7 octave; 1, 3, 5 scale steps), slide]
const BASS = {
  tresillo: [[[0, 3, 0], [3, 3, 0], [6, 2, 4], [8, 3, 0], [11, 3, 0], [14, 2, 4]], [[0, 3, 0], [6, 2, 0], [10, 2, 4], [14, 2, 6]], [[0, 2, 0], [3, 1, 0], [6, 2, 4], [8, 2, 0], [11, 2, 7], [14, 2, 4]]],
  offbeat: [[[2, 2, 0], [6, 2, 0], [10, 2, 0], [14, 2, 0]], [[2, 2, 0], [6, 2, 7], [10, 2, 0], [14, 2, 4]], [[2, 1, 0], [3, 1, 0], [6, 2, 0], [10, 2, 7], [14, 2, 0]]],
  root8: [[[0, 2, 0], [2, 2, 0], [4, 2, 0], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 0], [14, 2, 0]], [[0, 3, 0], [3, 3, 0], [6, 2, 0], [8, 3, 0], [11, 3, 0], [14, 2, 0]], [[0, 2, 0], [2, 2, 0], [4, 2, 7], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 7], [14, 2, 4]]],
  log: [[[0, 2, 0], [3, 2, 0], [6, 2, 2], [10, 1, 7], [11, 2, 6], [14, 2, 4]], [[0, 2, 0], [3, 2, 0], [6, 2, 2], [10, 2, 0], [14, 2, 4]], [[0, 3, 0], [4, 1, 0], [6, 2, 4], [9, 2, 2], [12, 2, 0], [14, 2, 6]],
    [[0, 2, 0], [3, 2, 7], [6, 2, 0], [8, 1, 0], [10, 2, 7], [14, 2, 4]], [[0, 1, 0], [2, 2, 7], [6, 1, 0], [7, 2, 4], [10, 2, 7, 1], [13, 3, 4]]],
  logsoft: [[[0, 4, 0], [6, 2, 4], [10, 4, 0]], [[0, 3, 0], [6, 3, 2], [12, 4, 4]], [[0, 6, 0], [10, 2, 7], [12, 4, 4]], [[0, 3, 0], [3, 3, 7], [10, 6, 4]]],
  bacardi: [[[0, 1, 0], [2, 1, 0], [4, 1, 7], [6, 1, 0], [8, 1, 0], [10, 1, 0], [12, 1, 7], [14, 1, 4]], [[0, 2, 0], [3, 1, 0], [4, 2, 0], [8, 2, 0], [11, 1, 0], [12, 2, 7]], [[0, 1, 0], [3, 1, 0], [4, 1, 7], [6, 1, 0], [8, 1, 0], [11, 1, 0], [12, 1, 7], [14, 1, 0]]],
  sparse: [[[0, 6, 0], [7, 2, 0], [10, 4, 4]], [[0, 4, 0], [7, 2, 0], [10, 3, 0], [14, 2, 6]], [[0, 7, 0], [8, 4, 4], [12, 3, 2]]],
  reese: [[[0, 8, 0], [10, 6, 0]], [[0, 6, 0], [8, 4, 2], [12, 4, 0]], [[0, 12, 0], [12, 4, 4]]],
  jungle: [[[0, 10, 0], [12, 4, 4]], [[0, 6, 0], [10, 6, 7]], [[0, 4, 0], [6, 2, 0], [10, 6, 4]]],
  glide808: [[[0, 6, 0], [6, 2, 0], [8, 4, 7, 1], [12, 4, 4, 1]], [[0, 8, 0], [8, 4, 0], [12, 4, 7, 1]], [[0, 6, 0], [6, 2, 0], [8, 6, 6, 1], [14, 2, 7, 1]], [[0, 3, 0], [3, 5, 7, 1], [8, 4, 4, 1], [12, 4, 0, 1]]],
  rage: [[[0, 8, 0], [8, 8, 0]], [[0, 6, 0], [6, 2, 0], [8, 8, 4]], [[0, 12, 0], [12, 4, 7, 1]]],
  dembow: [[[0, 3, 0], [3, 1, 0], [4, 2, 0], [8, 3, 4], [11, 1, 4], [12, 2, 4]], [[0, 2, 0], [3, 3, 0], [6, 2, 4], [8, 2, 0], [11, 3, 0], [14, 2, 6]], [[0, 3, 0], [3, 3, 0], [6, 2, 0], [8, 3, 4], [11, 3, 4], [14, 2, 7]]],
  octave: [[[2, 1, 0], [3, 1, 7], [6, 1, 0], [7, 1, 7], [10, 1, 0], [11, 1, 7], [14, 1, 0], [15, 1, 7]], [[0, 1, 0], [2, 2, 7], [4, 1, 0], [6, 2, 7], [8, 1, 0], [10, 2, 7], [12, 1, 0], [14, 2, 7]]],
  rolling: [[[0, 1, 0], [2, 1, 0], [3, 1, 0], [6, 1, 7], [8, 1, 0], [10, 1, 0], [11, 1, 0], [14, 1, 7]], [[2, 1, 0], [3, 1, 0], [5, 1, 0], [6, 2, 7], [10, 1, 0], [11, 1, 0], [13, 1, 0], [14, 2, 4]]],
  gqom: [[[0, 6, 0], [10, 6, 0]], [[0, 3, 0], [6, 4, 0], [10, 6, 4]], [[0, 8, 0], [10, 3, 0], [13, 3, 6]]],
  onedrop: [[[0, 2, 0], [2, 1, 0], [4, 2, 2], [7, 1, 4], [8, 3, 0], [12, 2, 4], [14, 2, 6]], [[0, 3, 0], [4, 2, 4], [6, 2, 2], [8, 4, 0], [12, 2, 7], [14, 2, 6]]],
  soca: [[[0, 2, 0], [3, 1, 0], [4, 2, 0], [6, 1, 7], [8, 2, 0], [11, 1, 0], [12, 2, 0], [14, 1, 7]], [[0, 2, 0], [3, 1, 7], [4, 2, 0], [7, 1, 0], [8, 2, 0], [11, 1, 7], [12, 2, 4], [14, 2, 0]]],
  walking: [[[0, 4, 0], [4, 4, 2], [8, 4, 4], [12, 4, 5]], [[0, 4, 0], [4, 4, 4], [8, 4, 7], [12, 4, 6]], [[0, 3, 0], [4, 4, 2], [8, 3, 4], [11, 1, 5], [12, 4, 4]]],
  newjack: [[[0, 2, 0], [3, 1, 0], [6, 1, 7], [7, 2, 0], [10, 2, 4], [12, 1, 0], [14, 2, 6]], [[0, 1, 0], [3, 2, 0], [6, 2, 7], [8, 1, 0], [11, 2, 4], [14, 2, 0]]],
  garage: [[[0, 3, 0], [6, 2, 7], [10, 2, 0], [13, 3, 4]], [[0, 2, 0], [3, 2, 0], [7, 2, 7], [10, 3, 0], [14, 2, 6]]]
};
// feel: per role, timing in ticks (a 16th is 6 ticks; + is late) and a velocity shape, over the four 16ths of each beat
const flat = v => [v, v, v, v];

/* Genres. Each has a base vocabulary and 2-3 styles; a style replaces what it names and keeps the rest.
   bpm: the style's tempo range. prog: chord progressions as scale degrees, '+' for a seventh chord. */
const G = GR.GROOVES = {
  bounce: { name: 'Bounce', swing: [0, 0], hatRoll: 0.08, fxRate: 0.4, bass: { style: 'follow', slide: 0.25 },
    prog: { minor: ['1 1 6 5', '1 6 7 1', '1 4 6 5'], major: ['1 5 6 4', '1 4 1 5'] },
    feel: { hat: { v: [1, 0.7, 0.9, 0.7] } }, jit: 0.03,
    kick: ['X---X---X--x--x-', 'X---X---X-x---x-', 'X---X---X--x-x--', 'X---x---X--x--xx'],
    snare: BACK, 'clap': ['--o---o---o---o-', '----X-------X---', '--o---o---X---o-'],
    hat: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-', 'x-xxx-x-x-xxx-x-'], openhat: ['--x---x---x---x-', '------x-------x-', '--------------x-'],
    'fx:squeak': ['--------x-------', '----------x-----', '------x-----x---'], 'fx:reload': ['--------x-------', '----------x-----'], 'fx:shot': ['x---------------'],
    styles: [
      { id: 'club', name: 'Club bounce', bpm: [145, 155] },
      { id: 'baltimore', name: 'Baltimore club', bpm: [128, 134], fxRate: 0.25, bass: { style: 'follow', slide: 0.1 },
        kick: ['X---X---X--X-X--', 'X---X---X-X-X---', 'X--xX---X--X-X--'], snare: ['----X-------X---'], clap: ['----X--x----X--x', '----X-------X-x-'],
        hat: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-'], openhat: ['--x---x---x---x-'] },
      { id: 'nola', name: 'New Orleans bounce', bpm: [96, 106], swing: [5, 15], hatRoll: 0.02, fxRate: 0.5, bass: { style: 'tresillo' },
        kick: ['X--x--X---x-X---', 'X--x--X-x-x-----', 'X--x--x---X-x---'], snare: ['----X--x----X---', '----X-------X--x'], clap: ['----X-------X---'],
        hat: ['x-x-x-x-x-x-x-x-', 'xxx-xxx-xxx-xxx-'], openhat: ['------x-------x-'], 'fx:chant': ['----x-------x---', '------------x---'] }
    ] },
  afrobeats: { name: 'Afrobeats', swing: [25, 40], fxRate: 0.15, bass: { style: 'tresillo' },
    prog: { minor: ['1 6 3 7', '1 4 6 5', '1 7 6 7', '4 5 1 1'], major: ['1 5 6 4', '4 5 6 6', '1 4 6 5', '6 4 1 5'] },
    feel: { shaker: { t: [0, -0.25, 0, -0.2], v: [1, 0.55, 0.8, 0.6] }, conga: { t: [0.15, 0.3, 0.15, 0.3], v: [1, 0.7, 0.85, 0.7] }, snare: { t: flat(0.2) },
      rim: { t: flat(-0.1), v: [0.8, 1, 0.8, 1] }, bell: { v: [1, 0.75, 0.9, 0.75] }, hat: { v: [1, 0.6, 0.85, 0.6] }, bass: { t: flat(0.1) } }, jit: 0.06,
    kick: ['X-----x---x-----', 'X-----x---x---x-', 'X--x--x---x-----', 'X-----x-x-----x-'],
    snare: ['----X-------X---', '--------X-------', '----X-------X--x'],
    rim: ['---x--x----x--x-', '--x--x----x--x--', '---x--x---x-x---'],
    shaker: ['oxoxoxoxoxoxoxox', 'oxxxoxxxoxxxoxxx', 'xoxoxoxoxoxoxoxo'], hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'],
    'conga:high': ['--x---xx--x---x-', '--x--x-x--x--xx-', '---x--x-x--x--x-'], 'conga:low': ['------x-------x-', '------x-----x-x-', '-------x------x-'],
    conga: ['--x---xx--x---x-', '---x--x-x--x--x-'], bell: ['x--x--x---x-x---', '--x--x-x--x--x-x', 'x-x--x-x-x--x-x-'], block: ['---x---x---x---x', '--x---x---x---x-'],
    styles: [
      { id: 'afrobeats', name: 'Afrobeats', bpm: [100, 112] },
      { id: 'afropop', name: 'Afropop', bpm: [95, 108], swing: [15, 28],
        kick: ['X-----x-X-------', 'X-----x-X-----x-', 'X--x--x-X-------'], snare: ['----X-------X---'],
        shaker: ['xoxoxoxoxoxoxoxo', 'oxoxoxoxoxoxoxox'], 'conga:high': ['------x-------x-', '--x-------x---x-'], bell: ['x--x--x---x-x---', ''] },
      { id: 'afroswing', name: 'Afroswing', bpm: [95, 104], swing: [30, 45], hatRoll: 0.08, bass: { style: 'follow', slide: 0.2 },
        kick: ['X------x--x-----', 'X-----x---x--x--', 'X--x------x-----'], snare: ['----X-------X---', '----X--x----X---'],
        hat: ['x-xxx-x-x-xxx-x-', 'x-x-x-xxx-x-x-x-'], rim: ['---x--x----x--x-'], 'conga:high': ['', '------x-------x-'], 'conga:low': [''] }
    ] },
  amapiano: { name: 'Amapiano', swing: [15, 28], fxRate: 0.1, bass: { style: 'log' },
    prog: { minor: ['1+ 4+ 7+ 3+', '1+ 6+ 4+ 5', '4+ 5 1+ 1+', '1+ 1+ 6+ 6+', '1+ 7 6+ 7'], major: ['2+ 5+ 1+ 6+', '1+ 6+ 2+ 5+', '4+ 3+ 2+ 1+', '1+ 4+ 1+ 4+'] },
    feel: { shaker: { t: [0, 0.4, 0, 0.5], v: [0.95, 0.5, 0.75, 0.55] }, block: { t: flat(0.3) }, snare: { t: flat(0.3) }, hat: { t: [0, 0.3, 0, 0.3], v: [1, 0.6, 0.85, 0.6] },
      openhat: { v: [0.8, 0.6, 1, 0.6] }, rim: { t: flat(0.2) } }, jit: 0.05,
    kick: ['X---X---X---X---', 'X---X---X---X---', 'X---X---X-------'], snare: ['----X-------X---', '--------X-------', '----x-------X--x'],
    shaker: ['xoxoxoxoxoxoxoxo', 'oxoxoxoxoxoxoxox', 'xxxoxxxoxxxoxxxo'], block: ['-x---x-x-x---x--', '--x--x---x-x--x-', '-x-x---x-x---x-x'],
    openhat: ['--x---x---x---x-'], hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], rim: ['-x---x-x-x---x--', '---x---x--x---x-'],
    styles: [
      { id: 'classic', name: 'Log drum', bpm: [110, 115] },
      { id: 'private', name: 'Private school', bpm: [107, 113], swing: [18, 30], bass: { style: 'logsoft' },
        prog: { minor: ['1+ 4+ 7+ 3+', '1+ 6+ 4+ 5+', '4+ 5+ 1+ 1+', '1+ 1+ 4+ 4+'], major: ['2+ 5+ 1+ 6+', '1+ 6+ 2+ 5+', '4+ 3+ 2+ 1+', '2+ 5+ 1+ 1+'] },
        kick: ['X---X---X---X---', 'X---X---X-------'], snare: ['--------X-------', '----x-------X---'],
        shaker: ['oxoxoxoxoxoxoxox', 'xoxoxoxoxoxoxoxo'], block: ['-x---x---x---x--', '---x---x---x---x'], openhat: [''], bell: ['--x---x---x---x-', ''] },
      { id: 'bacardi', name: 'Bacardi', bpm: [120, 128], swing: [5, 15], fxRate: 0.3, bass: { style: 'bacardi' },
        kick: FOUR, snare: ['----X-------X---', '----X--x----X---'], shaker: ['oxoxoxoxoxoxoxox'], hat: ['x-x-x-x-x-x-x-x-'],
        conga: ['--x--x---x--x-x-'], 'fx:whistle': ['------------x---', '----x-------x---'] }
    ] },
  afrohouse: { name: 'Afro House', swing: [10, 20], fxRate: 0.1, bass: { style: 'offbeat' },
    prog: { minor: ['1 1 7 6', '1 7 6 7', '1 4 1 4', '1 6 7 1', '1+ 1+ 4+ 4+'], major: ['6 4 1 5', '1 1 4 4'] },
    feel: { conga: { t: [0, 0.3, 0.1, 0.35], v: [1, 0.6, 0.85, 0.65] }, shaker: { t: [0, 0.25, 0, 0.25], v: [1, 0.55, 0.8, 0.6] }, rim: { t: flat(0.1) },
      openhat: { v: [0.6, 0.5, 1, 0.5] }, hat: { v: [0.6, 0.5, 1, 0.5] } }, jit: 0.04,
    kick: FOUR, snare: ['----X-------X---', '----X-------X--x'], shaker: ['oxoxoxoxoxoxoxox', 'xoxoxoxoxoxoxoxo'],
    'conga:high': ['--x--x---x---x--', 'x--x--x---x--x--', '--x-x--x--x--x--'], 'conga:low': ['x------x--x-----', '---x------x---x-'],
    conga: ['--x--x---x---x--', 'x--x--x---x--x--'], rim: ['---x---x---x--x-', '--x---x---x-x---'], openhat: ['--x---x---x---x-'], hat: ['oooooooooooooooo'],
    styles: [
      { id: 'afrohouse', name: 'Afro house', bpm: [119, 124] },
      { id: 'afrotech', name: 'Afro tech', bpm: [122, 126], swing: [0, 8], bass: { style: 'rolling' },
        hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], 'conga:high': ['--x--x---x---x--', '--x-----x--x--x-'] },
      { id: 'gqom', name: 'Gqom', bpm: [122, 128], swing: [0, 5], fxRate: 0.35, bass: { style: 'gqom' },
        kick: ['X--x--x---x--x--', 'X-----x---x--x--', 'X--x------x--x--'], snare: ['----X-------X---', '--------X-------'],
        tom: ['---x--x-----x---', '------x--x---x--'], shaker: [''], hat: ['--x---x---x---x-'], 'conga:high': [''], 'conga:low': [''], conga: [''], 'fx:siren': ['x---------------'] }
    ] },
  trap: { name: 'Trap', swing: [0, 0], hatRoll: 0.22, fxRate: 0.1, bass: { style: 'follow', slide: 0.3 },
    prog: { minor: ['1 1 6 5', '1 6 4 5', '1 1 4 6', '1 6 1 6', '6 6 1 1'], major: ['1 1 4 4', '6 6 4 4'] },
    feel: { hat: { v: [1, 0.85, 0.95, 0.85] } }, jit: 0,
    kick: ['X------x-x------', 'X------x--x---x-', 'X-----x---x-----', 'X--x---x-x------', 'X------xx-------'],
    snare: ['--------X-------', '--------X------x', '--------X-----x-'],
    hat: ['x-x-x-x-x-x-x-x-', 'xxx-x-x-xxx-x-x-', 'x-x-x-xxx-x-x-x-'], openhat: ['--------------x-', '------x-------x-', ''],
    styles: [
      { id: 'atlanta', name: 'Atlanta', bpm: [130, 150] },
      { id: 'rage', name: 'Rage', bpm: [150, 165], hatRoll: 0.05, bass: { style: 'rage', slide: 0.1 },
        kick: ['X-------X-------', 'X------xX-------', 'X-----X---X-----'], hat: ['x-x-x-x-x-x-x-x-', 'xxxxxxxxxxxxxxxx'], openhat: ['------x-------x-'] },
      { id: 'melodic', name: 'Melodic', bpm: [130, 145], hatRoll: 0.12, bass: { style: 'follow', slide: 0.15 },
        kick: ['X---------x-----', 'X------x--x-----', 'X-----x---------'], hat: ['x---x---x---x---', 'x-x-x-x-x-x-x-x-', 'x---x-x-x---x-x-'], openhat: ['--------------x-', ''] }
    ] },
  drill: { name: 'Drill', swing: [0, 0], hatRoll: 0.12, fxRate: 0.1, bass: { style: 'glide808', slide: 0.6 },
    prog: { minor: ['1 1 6 6', '1 6 1 7', '1 1 6 7', '6 6 1 1', '1 4 1 6'], major: ['6 6 4 4', '6 4 6 5'] },
    feel: { hat: { v: [1, 0.7, 0.85, 0.7] }, snare: { t: flat(0.1) } }, jit: 0.02,
    kick: ['X---------------', 'X---------x-----', 'X-----x---------', 'X--------x--x---'],
    snare: ['--------X-------', '-----o--X-----x-', '--------X--x----'],
    hat: ['x--x--x-xx--x--x--x-xx--', 'x--x--x--x--x--x-xx-x-xx', 'x-xx--x--x-xx--x--x--x--'], rim: ['--x--------x----', '------x-------x-'], openhat: ['', '--------------x-'],
    styles: [
      { id: 'uk', name: 'UK drill', bpm: [140, 145] },
      { id: 'ny', name: 'NY drill', bpm: [140, 148], bass: { style: 'follow', slide: 0.55, oct: true },
        kick: ['X------x--x-----', 'X--x---x--x---x-', 'X------x-x--x---'], snare: ['--------X------x', '--------X--x----'],
        hat: ['x--x--x-xx--x--x--x-xx--', 'x-xx--x--x--x-x--x--x-x-'] },
      { id: 'chicago', name: 'Chicago drill', bpm: [130, 140], hatRoll: 0.2, bass: { style: 'follow', slide: 0.15 },
        kick: ['X-----x---x-----', 'X--x-----x------'], snare: ['--------X-------'], hat: ['x-x-x-x-x-x-x-x-', 'x-x-xxx-x-x-x-x-'], rim: [''] }
    ] },
  pop: { name: 'Pop', swing: [0, 5], fxRate: 0.15, bass: { style: 'root8' },
    prog: { major: ['1 5 6 4', '6 4 1 5', '1 6 4 5', '4 1 5 6', '1 4 6 5'], minor: ['1 6 3 7', '1 4 6 5', '6 7 1 1'] },
    feel: { hat: { v: [1, 0.6, 0.85, 0.6] }, shaker: { v: [0.7, 0.5, 1, 0.5] } }, jit: 0.03,
    kick: ['X-------X-x-----', 'X-------X-------', 'X--x----X-x-----', 'X-----x-X-------'], snare: ['----X-------X---', '----X-------X--x'],
    hat: ['x-x-x-x-x-x-x-x-', 'xoxoxoxoxoxoxoxo'], openhat: ['--------------x-', '------x-------x-'], shaker: ['--x---x---x---x-', '----x-------x---'], 'fx:riser': ['x---------------'],
    styles: [
      { id: 'pop', name: 'Pop', bpm: [100, 125] },
      { id: 'dance', name: 'Dance pop', bpm: [118, 128], bass: { style: 'octave' },
        kick: FOUR, snare: ['----X-------X---'], hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], openhat: ['--x---x---x---x-'] },
      { id: 'ballad', name: 'Midtempo', bpm: [76, 96], bass: { style: 'sparse' },
        kick: ['X-------X-------', 'X------xX-------', 'X---------x-----'], snare: ['----X-------X---'], hat: ['x-x-x-x-x-x-x-x-', 'x---x---x---x---'], shaker: ['----x-------x---'], 'fx:riser': [''] }
    ] },
  house: { name: 'House', swing: [5, 15], fxRate: 0.1, bass: { style: 'offbeat' },
    prog: { minor: ['1+ 4+ 1+ 4+', '1+ 7 6 7', '1+ 6+ 4+ 5', '1+ 1+ 6+ 7'], major: ['2+ 5+ 1+ 6+', '1+ 4+ 1+ 4+', '4+ 5 3+ 6+'] },
    feel: { hat: { v: [0.6, 0.5, 1, 0.5] }, openhat: { v: [0.5, 0.5, 1, 0.5] }, shaker: { t: [0, 0.2, 0, 0.2], v: [1, 0.55, 0.8, 0.6] }, snare: { t: flat(0.15) } }, jit: 0.03,
    kick: FOUR, snare: ['----X-------X---', '----X-------X--x'], hat: ['oooooooooooooooo', '-o-o-o-o-o-o-o-o', 'oxoooxoooxoooxoo'], openhat: ['--x---x---x---x-'], shaker: ['oxoxoxoxoxoxoxox'],
    styles: [
      { id: 'deep', name: 'Deep house', bpm: [118, 124], swing: [8, 16] },
      { id: 'tech', name: 'Tech house', bpm: [124, 128], swing: [0, 8], bass: { style: 'rolling' },
        hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], rim: ['---x--x----x--x-', '-x---x-x---x--x-'] },
      { id: 'garage', name: 'UK garage', bpm: [130, 136], swing: [52, 62], bass: { style: 'garage' },
        kick: ['X------x--X-----', 'X-----x---X-----', 'X------x-x------'], snare: ['----X-------X---'],
        hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], rim: ['---x---x--x---x-'] }
    ] },
  reggaeton: { name: 'Reggaeton', swing: [0, 5], fxRate: 0.1, bass: { style: 'dembow' },
    prog: { minor: ['1 6 3 7', '1 4 5 1', '6 7 1 1', '1 6 7 6'], major: ['6 4 1 5', '1 5 6 4'] },
    feel: { hat: { v: [1, 0.6, 0.8, 0.6] }, conga: { t: flat(0.1) } }, jit: 0.02,
    kick: FOUR, snare: ['---X--X----X--X-', '---X--X-o--X--X-', '---X--X----X-oX-'], hat: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-'],
    conga: ['--x---x---x---xx', '-x---x-x-x---x--'], rim: ['---x--x----x--x-'],
    styles: [
      { id: 'dembow', name: 'Dembow', bpm: [88, 96] },
      { id: 'perreo', name: 'Perreo', bpm: [95, 104], hatRoll: 0.05, fxRate: 0.25,
        snare: ['---X--X----X--X-', '---X--X-x--X--X-'], hat: ['xxxxxxxxxxxxxxxx', 'x-x-x-x-x-x-x-x-'], 'fx:laser': ['x---------------', '--------x-------'] },
      { id: 'moombah', name: 'Moombahton', bpm: [106, 112], bass: { style: 'tresillo' },
        openhat: ['--x---x---x---x-'] }
    ] },
  dancehall: { name: 'Dancehall', swing: [5, 15], fxRate: 0.3, bass: { style: 'tresillo' },
    prog: { minor: ['1 6 7 1', '1 4 1 5', '1 7 6 7', '1 1 4 4'], major: ['1 4 5 4', '1 6 4 5'] },
    feel: { rim: { t: flat(0.2) }, hat: { t: [0, 0.15, 0, 0.15], v: [1, 0.6, 0.85, 0.6] } }, jit: 0.05,
    kick: ['X-----x-x-------', 'X-----x-x-----x-', 'X--x--x---x-----'], snare: ['----X-------X---'], rim: ['x--x--x-x--x--x-', 'x--x--x---x-x---'],
    hat: ['x-x-x-x-x-x-x-x-'], 'fx:airhorn': ['x---------------', 'x---x---x-------'],
    styles: [
      { id: 'modern', name: 'Dancehall', bpm: [95, 105] },
      { id: 'onedrop', name: 'One drop', bpm: [70, 80], swing: [10, 20], fxRate: 0.05, bass: { style: 'onedrop' },
        kick: ['--------X-------'], snare: ['--------X-------'], rim: ['--------X-------', '--------X-----x-'], hat: ['x-x-x-x-x-x-x-x-', 'x--xx--xx--xx--x'] },
      { id: 'soca', name: 'Soca', bpm: [155, 165], swing: [0, 5], bass: { style: 'soca' },
        kick: FOUR, snare: ['----X-------X---'], rim: ['--x---x---x---x-'], hat: ['--x---x---x---x-'], bell: ['x--x--x-x--x--x-'], 'fx:whistle': ['x-x-x-x---------', ''] }
    ] },
  boombap: { name: 'Boom Bap', swing: [50, 62], fxRate: 0.25, bass: { style: 'sparse' },
    prog: { minor: ['1+ 4+ 1+ 4+', '1+ 6+ 2 5', '1+ 1+ 4+ 4+', '1+ 7 6+ 5'], major: ['2+ 5+ 1+ 1+', '1+ 6+ 2+ 5+'] },
    feel: { snare: { t: flat(0.6) }, clap: { t: flat(0.6) }, hat: { t: [0, 0.4, 0.2, 0.5], v: [1, 0.5, 0.8, 0.55] }, kick: { t: [0, -0.15, 0, -0.15] }, bass: { t: flat(0.3) } }, jit: 0.2,
    kick: ['X-------x-x-----', 'X------xx-x-----', 'X-------x--x--x-', 'X-x-----x-x-----'], snare: ['----X-------X---', '----X-------X--o', '----X--o----X---'],
    hat: ['x-o-x-o-x-o-x-o-', 'x-x-x-x-x-x-x-x-', 'xox-xox-xox-xox-'], 'fx:scratch': ['------------x-x-', '--------x-x-----'],
    styles: [
      { id: 'nineties', name: '90s', bpm: [88, 96] },
      { id: 'jazzy', name: 'Jazzy', bpm: [84, 92], swing: [55, 65], bass: { style: 'walking' },
        kick: ['X-------x-x-----', 'X--x----x-x-----'], snare: ['----X-------X---', '----X--o----X--o'], 'cymbal:ride': ['x-x-x-x-x-x-x-x-', 'x--xx--xx--xx--x'] },
      { id: 'hard', name: 'Hardcore', bpm: [90, 98], swing: [40, 52],
        kick: ['X-x-----x-x-----', 'X--x----xx------', 'X-x----x--x-----'], snare: ['----X-------X---', '----X-----x-X---'], hat: ['x-x-x-x-x-x-x-x-', 'x-xxx-x-x-xxx-x-'] }
    ] },
  rnb: { name: 'R&B', swing: [0, 10], hatRoll: 0.06, fxRate: 0.05, bass: { style: 'follow', slide: 0.15 },
    prog: { major: ['2+ 5+ 1+ 6+', '4+ 3+ 2+ 1+', '1+ 4+ 3+ 6+', '4+ 5+ 3+ 6+'], minor: ['1+ 4+ 7+ 3+', '1+ 6+ 4+ 5+', '4+ 5+ 1+ 1+'] },
    feel: { hat: { t: [0, 0.15, 0, 0.15], v: [1, 0.55, 0.8, 0.55] }, snare: { t: flat(0.25) }, shaker: { t: [0, 0.2, 0, 0.2] } }, jit: 0.08,
    kick: ['X-------x--x----', 'X-------x--x--x-', 'X--x----x-------'], snare: ['----X-------X---'],
    hat: ['x---x---x---x-x-x---x---x---xxxx', 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-xxxx', 'x---x-x-x---x-x-x---x-x-x---xxx-'], shaker: ['--x---x---x---x-', '--x---x---x-x-x-'],
    styles: [
      { id: 'modern', name: 'Modern R&B', bpm: [60, 75] },
      { id: 'neosoul', name: 'Neo soul', bpm: [80, 95], swing: [45, 58], hatRoll: 0, bass: { style: 'walking' },
        feel: { snare: { t: flat(0.5) }, hat: { t: [0, 0.3, 0.1, 0.3], v: [1, 0.5, 0.8, 0.5] } },
        kick: ['X------x--x-----', 'X--x----x-------', 'X-----x---x--x--'], snare: ['----X-------X---', '----X--o----X--o'], hat: ['x-xxx-xxx-xxx-xx', 'x-x-x-x-x-x-x-x-'] },
      { id: 'newjack', name: 'New jack swing', bpm: [100, 112], swing: [55, 65], hatRoll: 0, bass: { style: 'newjack' },
        kick: ['X--x--x-x--x----', 'X--x----x--x--x-'], snare: ['----X-------X---'], hat: ['x-xxx-xxx-xxx-xx'] }
    ] },
  lofi: { name: 'Lo-fi', swing: [55, 65], fxRate: 0.05, bass: { style: 'sparse' },
    prog: { major: ['2+ 5+ 1+ 1+', '4+ 3+ 2+ 1+', '1+ 6+ 2+ 5+', '4+ 4+ 1+ 1+'], minor: ['1+ 4+ 1+ 4+', '4+ 7+ 3+ 6+', '1+ 6+ 2 5'] },
    feel: { snare: { t: flat(0.8) }, hat: { t: [0.3, 0.6, 0.4, 0.7], v: [1, 0.5, 0.75, 0.55] }, kick: { t: [0, -0.2, 0, -0.2] }, bass: { t: flat(0.4) } }, jit: 0.3,
    kick: ['X---------x-----', 'X---------x--x--', 'X-x-------x-----'], snare: ['----X-------X---', '----X-------X--o', '----X--o----X---'],
    hat: ['x-x-x-x-x-x-x-x-', 'xoxoxoxoxoxoxoxo'], cymbal: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'],
    styles: [
      { id: 'chillhop', name: 'Chillhop', bpm: [80, 90] },
      { id: 'jazzhop', name: 'Jazzhop', bpm: [70, 80], swing: [58, 66], bass: { style: 'walking' },
        kick: ['X-------x-------', 'X------xx-------'], cymbal: ['x-x-x-x-x-x-x-x-', 'x--xx--xx--xx--x'] },
      { id: 'lofihouse', name: 'Lo-fi house', bpm: [118, 124], swing: [10, 20], bass: { style: 'offbeat' },
        feel: { snare: { t: flat(0.3) }, hat: { t: [0.1, 0.2, 0.1, 0.2], v: [0.6, 0.5, 1, 0.5] } },
        kick: FOUR, snare: ['----X-------X---'], hat: ['--x---x---x---x-'], cymbal: [''] }
    ] },
  jersey: { name: 'Jersey Club', swing: [0, 0], hatRoll: 0.05, fxRate: 0.9, bass: { style: 'follow', slide: 0.1 },
    prog: { minor: ['1 6 3 7', '1 1 6 6', '1 4 6 5'], major: ['6 4 1 5', '1 5 6 4'] },
    feel: {}, jit: 0,
    kick: ['X---X---X-X---X-', 'X---X---X-X-X-X-', 'X---X---XX-X--X-'], snare: ['----X-------X---', '----X-----x-X---'],
    hat: ['--x---x---x---x-'], 'fx:squeak': ['--x---x---x---x-', 'x-x---x-x-x---x-'],
    styles: [
      { id: 'classic', name: 'Jersey club', bpm: [138, 145] },
      { id: 'drill', name: 'Jersey drill', bpm: [140, 150], hatRoll: 0.1, fxRate: 0.4, bass: { style: 'glide808', slide: 0.5 },
        snare: ['--------X-------', '--------X--x----'], hat: ['x--x--x-xx--x--x--x-xx--', 'x--x--x--x--x--x-xx-x-xx'] }
    ] },
  dnb: { name: 'Drum & Bass', swing: [0, 5], fxRate: 0.1, bass: { style: 'reese' },
    prog: { minor: ['1 6 3 7', '1 1 6 7', '1 4 6 5', '1 6 7 7'], major: ['1 5 6 4', '6 4 1 5'] },
    feel: { hat: { v: [1, 0.55, 0.8, 0.6] }, shaker: { t: [0, 0.15, 0, 0.15] }, cymbal: { t: [0, 0.15, 0, 0.15] } }, jit: 0.05,
    kick: ['X---------x-----', 'X---------x--x--', 'X-x-------x-----'], snare: ['----X-------X---', '----X-------X--o', '----X--o----X---'],
    hat: ['x-x-x-x-x-x-x-x-', 'xoxoxoxoxoxoxoxo'], cymbal: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'],
    styles: [
      { id: 'roller', name: 'Rollers', bpm: [172, 176] },
      { id: 'liquid', name: 'Liquid', bpm: [170, 174], shaker: ['oxoxoxoxoxoxoxox'], 'cymbal:ride': ['x-x-x-x-x-x-x-x-'] },
      { id: 'jungle', name: 'Jungle', bpm: [160, 170], bass: { style: 'jungle' },
        kick: ['X---------x-----', 'X-x-------x-----', 'X---------xx----'], snare: ['----X--o-o--X--o', '----X-o--o-oX---', '----X--o----X-oo'] }
    ] }
};
GR.GENRES = Object.keys(G);
GR.BASS_STYLES = BASS;
const pick = a => a[Math.floor(Math.random() * a.length)];
const chance = p => Math.random() < p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- styles ---------- */
GR.stylesOf = genre => ((G[genre] || G.trap).styles || [{ id: 'main', name: (G[genre] || G.trap).name, bpm: [90, 140] }]);
GR.styleOf = (genre, id) => { const l = GR.stylesOf(genre); return l.find(s => s.id === id) || l[0]; };
// the genre's vocabulary with the style's own parts on top
GR.grooveOf = function (genre, styleId) {
  const base = G[genre] || G.trap, st = GR.styleOf(genre in G ? genre : 'trap', styleId);
  const g = Object.assign({}, base, st);
  g.genre = genre in G ? genre : 'trap'; g.style = st.id; g.styleName = st.name;
  g.bass = Object.assign({}, base.bass, st.bass);
  g.feel = Object.assign({}, base.feel, st.feel);
  g.prog = st.prog || base.prog;
  delete g.styles;
  return g;
};
GR.styleBpm = (genre, id) => GR.styleOf(genre, id).bpm || [90, 140];

/* ---------- what you taught it: learned grids and liked or skipped patterns ----------
   GR.LEARN['genre:style'] = { n: loops learned, parts: { kick: { bars, p: [16], v: [16] }, ... }, bass: [phrases] }
   GR.WEIGHTS['genre:style:part:pattern'] = how much more (or less) often that pattern is picked */
GR.LEARN = GR.LEARN || {};
GR.WEIGHTS = GR.WEIGHTS || {};
GR.lastPicks = {};
const learnedFor = g => GR.LEARN[g.genre + ':' + g.style] || null;
function pickW(list, prefix) {
  if (!list.length) return undefined;
  const w = list.map(s => GR.WEIGHTS[prefix + JSON.stringify(s)] == null ? 1 : GR.WEIGHTS[prefix + JSON.stringify(s)]);
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

function parse(s) {
  return Array.from(s).map(c => (c === '-' || c === '.') ? null : {
    vel: c === 'o' ? 0.42 : c === 'X' ? 1 : 0.9, roll: c === 'r' ? 2 : c === 't' ? 3 : c === 'q' ? 4 : 1, anchor: c === 'X'
  });
}
const partKey = (tr, role) => (tr.inst !== role ? tr.inst : role);
function templatesFor(g, tr, role) {
  return g[tr.inst + ':' + tr.sound] || (tr.inst !== role && g[tr.inst]) || g[role] || null;
}
// how strong a step is: 1 on the beat, 0.7 on the 8th, 0.35 elsewhere
function weight(i, n) { const per = n / 4; return i % per === 0 ? 1 : (Number.isInteger(per / 2) && i % (per / 2) === 0) ? 0.7 : 0.35; }

// a bar drawn from a learned grid: each step plays as often as it did in your loops
function fromGrid(L) {
  return L.p.map((p, i) => (chance(p) ? { vel: clamp(L.v[i] || 0.85, 0.2, 1), roll: 1, anchor: p >= 0.85 } : null));
}

function vary(steps, role, g, cx, avoid) {
  const n = steps.length, out = steps.map(s => s && Object.assign({}, s));
  const roleAdd = { kick: 0.8, snare: 0.45, hat: 1.4, shaker: 1.4, openhat: 0.3, cymbal: 0.2, fx: 0, tom: 0.2 }[role];
  const add = [0.015, 0.06, 0.13][cx] * (roleAdd == null ? 1 : roleAdd), drop = [0.03, 0.1, 0.08][cx];
  for (let i = 0; i < n; i++) {
    const s = out[i];
    if (s) {
      if (!s.anchor && chance(drop)) out[i] = null;
      else if ((role === 'snare' || role === 'kick') && !s.anchor && chance(0.08 * cx)) s.vel = 0.42;
    } else if (chance(add * weight(i, n)) && !(avoid && avoid.has(i * (TPB / n)))) {
      out[i] = { vel: role === 'snare' ? 0.42 : role === 'kick' ? (chance(0.5) ? 0.5 : 0.8) : 0.55 + Math.random() * 0.3, roll: 1 };
    }
  }
  if (role === 'hat' && g.hatRoll) {
    out.forEach(s => { if (s && s.roll === 1 && chance(g.hatRoll * (cx + 1) / 2)) s.roll = pick([2, 2, 3, 4]); });
  }
  return out;
}
// big: the end of the loop; small: the end of the first 4 bars of an 8 bar loop
function fill(steps, role, g, cx, small) {
  const n = steps.length, per = n / 4, out = steps.map(s => s && Object.assign({}, s)), last = n - per;
  const put = (i, vel, roll) => { if (i >= 0 && i < n && !(out[i] && out[i].anchor)) out[i] = { vel, roll: roll || 1 }; };
  if (small) {
    if (role === 'snare' && chance(0.6)) put(n - 1, 0.6, chance(0.4) ? 2 : 1);
    if (role === 'kick' && chance(0.4)) put(last + Math.round(per / 2) + 1, 0.6);
    if (role === 'hat' && g.hatRoll && chance(0.6)) { const i = last + per - 2; if (i >= 0) out[i] = { vel: 0.75, roll: pick([2, 3]) }; }
    if (role === 'openhat' && chance(0.4)) put(n - 2, 0.8);
    return out;
  }
  if (role === 'kick' && chance(0.5 + 0.2 * cx)) put(last + Math.round(per / 2) + (chance(0.5) ? 1 : 0), 0.7);
  if (role === 'snare') {
    const v = pick(['ramp', 'roll', 'flam', 'none']);
    if (v === 'ramp') { put(n - 3, 0.45); put(n - 2, 0.6); put(n - 1, 0.8); }
    if (v === 'roll') put(n - 1, 0.75, 3);
    if (v === 'flam') { put(n - 2, 0.42); put(n - 1, 0.9); }
  }
  if (role === 'hat' && g.hatRoll) { for (let i = last; i < n; i++) if (out[i] || chance(0.6)) out[i] = { vel: 0.75, roll: pick([2, 3]) }; }
  if (role === 'tom') { for (let k = 0; k < Math.min(per, 4); k++) put(last + Math.round(k * per / 4), 0.85 - k * 0.08); }
  if (role === 'openhat' && chance(0.5)) put(n - 2, 0.85);
  return out;
}
function humanize(steps, role, shaped) {
  const n = steps.length;
  steps.forEach((s, i) => {
    if (!s) return;
    let v = s.vel * (0.94 + Math.random() * 0.12);
    if (!shaped && (role === 'hat' || role === 'shaker') && weight(i, n) < 0.5) v *= 0.85;
    s.vel = Math.round(clamp(v, 0.05, 1) * 100) / 100;
  });
  return steps;
}
// the genre's feel: where each part sits against the grid (a little early or late) and how it accents
function feelFor(g, tr, role) { const f = g.feel || {}; return f[tr.inst + ':' + tr.sound] || f[tr.inst] || f[role] || null; }
function applyFeel(steps, f, jit, bar) {
  const n = steps.length;
  steps.forEach((s, i) => {
    if (!s) return;
    const k = Math.floor(i * 16 / n);
    if (f && f.v) s.vel = Math.round(clamp(s.vel * f.v[k % f.v.length] * (s.anchor ? 1.05 : 1), 0.05, 1) * 100) / 100;
    let d = (f && f.t ? f.t[k % f.t.length] : 0) + (jit ? (Math.random() * 2 - 1) * jit : 0);
    if (bar === 0 && i === 0 && d < 0) d = 0;   // nothing before the very first beat
    d = Math.round(clamp(d, -1.5, 1.5) * 100) / 100;
    if (Math.abs(d) >= 0.02) s.nudge = d; else delete s.nudge;
  });
  return steps;
}
// a bar with no template: a few hits that stay out of the kick's and snare's way
function freeBar(role, g, cx, n, avoid) {
  const steps = new Array(n).fill(null);
  if (role === 'cymbal') { steps[0] = { vel: 0.8, roll: 1 }; return steps; }
  if (role === 'tom') return steps;
  const dens = { rim: 0.22, conga: 0.3, bell: 0.25, block: 0.25, shaker: 0.6, perc: 0.25, hat: 0.5, openhat: 0.1 }[role] || 0.2;
  for (let i = 0; i < n; i++) {
    if (avoid && avoid.has(i * (TPB / n))) continue;
    if (chance(dens * weight(i, n) * (0.8 + 0.2 * cx))) steps[i] = { vel: 0.6 + Math.random() * 0.3, roll: 1 };
  }
  return steps;
}

function notesFromBar(steps, bar) {
  const st = TPB / steps.length, out = [];
  steps.forEach((s, i) => {
    if (!s) return;
    const n = { t: bar * TPB + i * st, vel: s.vel };
    if (s.roll > 1) n.roll = s.roll;
    if (s.nudge) n.nudge = s.nudge;
    out.push(n);
  });
  return out;
}
function hitsIn(P, roles, bar) {
  const set = new Set();
  P.tracks.forEach(t => { if (roles.includes(GR.roleOf(t))) t.notes.forEach(n => { if (n.t >= bar * TPB && n.t < (bar + 1) * TPB) set.add(n.t - bar * TPB); }); });
  return set;
}

/* ---------- phrases: how the bars of a loop relate ----------
   4 bars: A A A' A+fill.  8 bars: A A A' A+small fill | A A A' A+big fill. A' is a light variation. */
GR.phraseRole = function (b, loop) {
  if (b === loop - 1) return loop > 1 ? 'fill' : 'A';
  if (loop === 8 && b === 3) return 'small';
  return b % 4 === 2 ? 'B' : 'A';
};

/* ---------- drums ---------- */
function drumBars(P, tr, g, cx, bars) {
  const role = GR.roleOf(tr), tpl = templatesFor(g, tr, role), part = partKey(tr, role);
  const prefix = g.genre + ':' + g.style + ':' + part + ':';
  const avoidFor = b => (['kick', 'snare', 'hat', 'cymbal', 'openhat', 'fx'].includes(role) ? null : hitsIn(P, ['kick', 'snare'], b));
  const learned = learnedFor(g), L = learned && learned.parts && (learned.parts[part] || learned.parts[role]);
  let base = null, src = null;
  if (L && L.bars && role !== 'fx' && chance(learned.n >= 3 ? 0.7 : 0.5)) { base = fromGrid(L); src = 'learned'; if (!base.some(s => s)) base = null; }
  if (!base && tpl) { src = pickW(tpl, prefix); base = parse(src || '----------------'); }   // '' in a list means 'leave it out this time'
  // a part the genre has no patterns for gets one made up once, so it repeats with the phrase like the rest
  if (!base && !['fx', 'cymbal', 'tom'].includes(role)) base = freeBar(role, g, cx, 16, avoidFor(bars[0]));
  GR.lastPicks[tr.id] = src && src !== 'learned' ? prefix + JSON.stringify(src) : null;
  const res = base ? base.length : 16;
  const A = base ? vary(base, role, g, cx) : null, B = A ? vary(A, role, g, Math.max(0, cx - 1)) : null;
  const out = {}, loop = P.bars, f = feelFor(g, tr, role);
  bars.forEach(b => {
    let steps;
    const ph = GR.phraseRole(b, loop);
    if (role === 'fx') {
      steps = (chance(g.fxRate || 0.2) || (b === bars[bars.length - 1] && !Object.values(out).some(x => x.some(s => s)))) && tpl
        ? vary(parse(pickW(tpl, prefix)), role, g, cx) : new Array(res).fill(null);
    } else if (!A) {
      steps = role === 'cymbal' ? (b % 4 === 0 ? freeBar(role, g, cx, res) : new Array(res).fill(null))
        : role === 'tom' ? (ph === 'fill' ? fill(new Array(res).fill(null), role, g, cx) : new Array(res).fill(null))
        : freeBar(role, g, cx, res, avoidFor(b));
    } else if (ph === 'fill' && bars.length > 1) steps = fill(A, role, g, cx);
    else if (ph === 'small' && bars.length > 1) steps = fill(A, role, g, cx, true);
    else steps = ph === 'B' ? B : A;
    steps = humanize(steps.map(s => s && Object.assign({}, s)), role, !!(f && f.v));
    out[b] = applyFeel(steps, f, g.jit || 0, b);
  });
  return { res, out };
}

/* ---------- chords: one per bar, they steer the bass ---------- */
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const QUALITY = { '': [4, 7, 11], m: [3, 7, 10], dim: [3, 6, 9], '7': [4, 7, 10], m7: [3, 7, 10], maj7: [4, 7, 11], m7b5: [3, 6, 10], sus2: [2, 7, 10], sus4: [5, 7, 10] };
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// sharp keys (G D A E B F# major, and their relative minors) spell their chords with sharps
const sharpKey = P => { if (!P) return false; const sc = GR.SCALES[P.scale] || [0, 2, 3]; const rel = (P.key + ((sc[2] === 3 || sc[1] === 3) ? 3 : 0)) % 12; return [7, 2, 9, 4, 11, 6].includes(rel); };
GR.chordName = (c, P) => (c ? (sharpKey(P) ? SHARPS : FLATS)[((c.r % 12) + 12) % 12] + (c.q === 'dim' ? '°' : c.q === 'm7b5' ? 'ø' : c.q) : '');
// semitones above the root for the bass degrees: 0 root, 2 third, 4 fifth, 6 seventh, 7 octave
function chordStep(q, d) { const iv = QUALITY[q] || QUALITY.m; return d === 0 ? 0 : d === 2 ? iv[0] : d === 4 ? iv[1] : d === 6 ? iv[2] : d === 7 ? 12 : 0; }
const qualityAt = (P, pc) => {
  const sc = GR.SCALES[P.scale], i = sc.indexOf(((pc - P.key) % 12 + 12) % 12);
  if (i < 0 || sc.length < 7) return GR.SCALES[P.scale][2] === 3 ? 'm' : '';
  const third = (sc[(i + 2) % 7] - sc[i] + 12) % 12, fifth = (sc[(i + 4) % 7] - sc[i] + 12) % 12;
  return third === 3 ? (fifth === 6 ? 'dim' : 'm') : '';
};
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
// the chords that belong to the key: triads and sevenths on each degree
GR.diatonicChords = function (P) {
  const sc = GR.SCALES[P.scale], out = [];
  if (sc.length < 7) {
    for (let r = 0; r < 12; r++) out.push({ r: (P.key + r) % 12, q: GR.SCALES[P.scale][1] === 3 || P.scale.startsWith('minor') ? 'm' : '', roman: '' });
    return { triads: out, sevenths: [] };
  }
  const triads = [], sevenths = [];
  for (let i = 0; i < 7; i++) {
    const r = (P.key + sc[i]) % 12, third = (sc[(i + 2) % 7] - sc[i] + 12) % 12, fifth = (sc[(i + 4) % 7] - sc[i] + 12) % 12, sev = (sc[(i + 6) % 7] - sc[i] + 12) % 12;
    const q = third === 3 ? (fifth === 6 ? 'dim' : 'm') : '';
    const roman = third === 3 ? ROMAN[i].toLowerCase() + (q === 'dim' ? '°' : '') : ROMAN[i];
    triads.push({ r, q, roman });
    sevenths.push({ r, q: q === 'dim' ? 'm7b5' : q === 'm' ? 'm7' : sev === 11 ? 'maj7' : '7', roman: roman + '7' });
  }
  return { triads, sevenths };
};
// read the chords off the bass: the first bass note of each bar is its root
GR.inferChords = function (P) {
  const bass = P.tracks.filter(t => GR.INST[t.inst].pitched), out = [];
  for (let b = 0; b < P.bars; b++) {
    let first = null;
    bass.forEach(t => t.notes.forEach(n => { if (n.t >= b * TPB && n.t < (b + 1) * TPB && (!first || n.t < first.t)) first = n; }));
    out.push(first ? { r: ((first.p % 12) + 12) % 12, q: qualityAt(P, first.p) } : null);
  }
  return out;
};

// a bass degree over a chord: from the scale when the chord belongs to the key, so every note stays in key
function chordPitch(P, rootMidi, chord, d) {
  const sc = GR.SCALES[P.scale], i = sc.indexOf(((chord.r - P.key) % 12 + 12) % 12);
  const dia = i >= 0 && sc.length >= 7 ? GR.diatonicChords(P) : null;
  const inKey = dia && (dia.triads[i].q === chord.q || dia.sevenths[i].q === chord.q);
  if (!inKey || d === 0 || d === 7) return rootMidi + chordStep(chord.q, d);
  const j = i + d;
  return rootMidi - sc[i] + sc[j % sc.length] + 12 * Math.floor(j / sc.length);
}

/* ---------- chord progressions ---------- */
const minorish = P => GR.SCALES[P.scale][2] === 3 || GR.SCALES[P.scale][1] === 3;
// one of the style's progressions, as chords for every bar of the loop
GR.progressionFor = function (P, g) {
  const sc = GR.SCALES[P.scale];
  if (sc.length < 7) {   // pentatonic and chromatic: roots from the scale, the quality from the scale's third
    const q = minorish(P) ? 'm' : '', degs = pick([[0, 0, 3, 4], [0, 3, 0, 4], [0, 4, 3, 0]]);
    return Array.from({ length: P.bars }, (_, b) => ({ r: (P.key + sc[degs[b % 4] % sc.length]) % 12, q }));
  }
  const { triads, sevenths } = GR.diatonicChords(P);
  const list = (g.prog && (minorish(P) ? g.prog.minor : g.prog.major)) || ['1 6 4 5'];
  const prefix = g.genre + ':' + g.style + ':chords:';
  const src = pickW(list, prefix);
  GR.lastPicks._chords = prefix + JSON.stringify(src);
  const toks = src.trim().split(/\s+/);
  const chord = tk => { const d = clamp((parseInt(tk, 10) || 1) - 1, 0, 6), c = (tk.includes('+') ? sevenths : triads)[d]; return { r: c.r, q: c.q }; };
  const out = [];
  for (let b = 0; b < P.bars; b++) out.push(chord(toks[b % toks.length]));
  // 8 bars: the second half answers the first, often with a turnaround into the top
  if (P.bars === 8 && chance(0.5)) out[7] = chord(minorish(P) ? pick(['5', '7', '4']) : pick(['5', '4', '2+']));
  return out;
};

/* ---------- bass ---------- */
function bassNotes(P, tr, g, cx, bars, kickNotes) {
  const style = (tr.inst === 'logdrum' && !/^log|bacardi/.test(g.bass.style) && g.bass.style !== 'follow') ? 'log' : g.bass.style;
  const stepT = TPB / 16, notes = [];
  const lo = GR.INST[tr.inst].id === 'bass' ? 28 : 26, mono = GR.INST[tr.inst].mono;
  if (!Array.isArray(P.chords)) P.chords = [];
  const prog = GR.progressionFor(P, g);
  const prefix = g.genre + ':' + g.style + ':bass:';
  const learned = learnedFor(g), pool = (BASS[style] || BASS.root8).concat(learned && learned.bass && learned.bass.length ? learned.bass : []);
  const rhythmA = style === 'follow' ? null : pickW(pool, prefix), rhythmB = style === 'follow' ? null : pickW(pool, prefix);
  GR.lastPicks[tr.id] = rhythmA ? prefix + JSON.stringify(rhythmA) : null;
  const f = (g.feel || {}).bass;
  bars.forEach(b => {
    const b0 = b * TPB, ph = GR.phraseRole(b, P.bars);
    if (!P.chords[b]) P.chords[b] = prog[b % prog.length];
    const chord = P.chords[b];
    let root = chord.r; while (root < lo) root += 12;
    let rhythm;
    if (style === 'follow') {
      let hits = kickNotes.filter(n => n.t >= b0 && n.t < b0 + TPB).map(n => Math.round((n.t - b0) / stepT));
      if (!hits.length) hits = parse(pick(g.kick)).map((s, i) => (s ? i : -1)).filter(i => i >= 0);
      hits = [...new Set(hits)].sort((a, c) => a - c);
      rhythm = hits.map((s, i) => {
        const next = i + 1 < hits.length ? hits[i + 1] : 16;
        const d = i === 0 ? 0 : g.bass.oct && chance(0.45) ? 7 : pick([0, 0, 0, 0, 7, 4, 6, 2].slice(0, 4 + cx * 2));
        return [s, clamp(next - s, 1, 8), d, g.bass.oct && d === 7 ? 1 : 0];
      });
    } else rhythm = (ph === 'B' || (ph === 'fill' && chance(0.6))) && chance(0.4 + 0.2 * cx) ? rhythmB : rhythmA;
    rhythm.forEach(([s, len, d, sl], i) => {
      if (i > 0 && cx === 0 && d !== 0 && !sl && chance(0.5)) d = 0;
      else if (i > 0 && style !== 'follow' && !sl && chance(0.15 * cx)) d = pick([0, 4, 7, 6, 2]);   // a passing note, still in the key
      const n = { t: b0 + s * stepT, len: len * stepT, p: chordPitch(P, root, chord, d), vel: Math.round((i === 0 ? 0.9 : 0.8 + Math.random() * 0.1) * 100) / 100 };
      if (mono && i > 0 && (sl || (g.bass.slide && chance(g.bass.slide * (0.5 + cx * 0.4))))) n.slide = true;
      if (f && f.t) { const dd = f.t[s % f.t.length] + (g.jit ? (Math.random() * 2 - 1) * g.jit * 0.5 : 0); if (!(b === 0 && s === 0) && Math.abs(dd) >= 0.02) n.nudge = Math.round(clamp(dd, -1.5, 1.5) * 100) / 100; }
      notes.push(n);
    });
  });
  return notes;
}

/* ---------- public ---------- */
// opts: { genre, style, complexity 0-2, bar: number (just that bar) or null (the whole loop) }
GR.generateTrack = function (P, tr, opts) {
  const g = GR.grooveOf(opts.genre, opts.style), cx = clamp(opts.complexity == null ? 1 : opts.complexity, 0, 2);
  const bars = opts.bar != null ? [opts.bar] : Array.from({ length: P.bars }, (_, i) => i);
  const keep = n => !bars.includes(Math.floor(n.t / TPB)) || n.t >= P.bars * TPB;
  if (GR.roleOf(tr) === 'bass') {
    const kickTr = P.tracks.find(t => GR.roleOf(t) === 'kick');
    const fresh = bassNotes(P, tr, g, cx, bars, kickTr ? kickTr.notes : []);
    tr.res = 16; tr.notes = tr.notes.filter(keep).concat(fresh);
  } else {
    const { res, out } = drumBars(P, tr, g, cx, bars);
    let notes = tr.notes.filter(keep);
    if (res !== tr.res) {   // a new grid: the other bars move onto it
      const st = TPB / res; notes = notes.map(n => Object.assign({}, n, { t: Math.round(n.t / st) * st }));
      tr.res = res;
    }
    bars.forEach(b => { notes = notes.concat(notesFromBar(out[b], b)); });
    tr.notes = notes;
  }
  tr.notes.sort((a, b) => a.t - b.t || (a.p || 0) - (b.p || 0));
};
// every track at once, in an order that lets later parts fit the earlier ones
GR.generateAll = function (P, opts) {
  const order = ['kick', 'snare', 'hat', 'openhat', 'cymbal', 'shaker', 'rim', 'conga', 'bell', 'block', 'perc', 'tom', 'fx', 'bass'];
  const g = GR.grooveOf(opts.genre, opts.style), firstOfRole = {};
  // a new groove gets new chords from the style, unless you picked your own
  if (opts.bar == null && !P.chordLock) P.chords = GR.progressionFor(P, g);
  const tracks = P.tracks.slice().sort((a, b) => order.indexOf(GR.roleOf(a)) - order.indexOf(GR.roleOf(b)));
  tracks.forEach(tr => {
    const role = GR.roleOf(tr), first = firstOfRole[role];
    // a second snare-role track (a clap over a snare) layers on the first unless the genre gives it its own part
    const own = t => !!(g[t.inst + ':' + t.sound] || (t.inst !== GR.roleOf(t) && g[t.inst]));
    if (first && role === 'snare' && !own(tr) && !own(first)) {
      const bars = opts.bar != null ? [opts.bar] : null;
      tr.notes = tr.notes.filter(n => bars && !bars.includes(Math.floor(n.t / TPB)))
        .concat(first.notes.filter(n => !bars || bars.includes(Math.floor(n.t / TPB))).filter(n => n.vel > 0.5).map(n => Object.assign({}, n)));
      tr.res = first.res;
      GR.lastPicks[tr.id] = null;
      return;
    }
    GR.generateTrack(P, tr, opts);
    if (!first) firstOfRole[role] = tr;
  });
  if (opts.bar == null) P.swing = Math.round(g.swing[0] + Math.random() * (g.swing[1] - g.swing[0]));
};

/* ---------- learning from your loops ---------- */
const DEG_OF = [0, 0, 1, 2, 2, 3, 0, 4, 5, 5, 6, 6];   // semitones above the bar's root -> bass degree
// add a project's patterns (an imported MIDI loop, or the groove you liked) to what a style knows
GR.learnProject = function (src, genre, style) {
  const key = genre + ':' + style, cur = GR.LEARN[key] || { n: 0, parts: {}, bass: [] };
  const loopT = src.bars * TPB;
  let used = 0;
  src.tracks.forEach(tr => {
    const role = GR.roleOf(tr);
    if (role === 'bass') {
      for (let b = 0; b < src.bars; b++) {
        const ns = tr.notes.filter(n => n.t >= b * TPB && n.t < (b + 1) * TPB).sort((x, y) => x.t - y.t);
        if (ns.length < 2) continue;
        const root = ns[0].p;
        const ph = ns.map(n => {
          const iv = n.p - root, d = iv >= 12 && iv % 12 === 0 ? 7 : DEG_OF[((iv % 12) + 12) % 12];
          return [clamp(Math.round((n.t - b * TPB) / 6), 0, 15), clamp(Math.round((n.len || 6) / 6), 1, 16), d].concat(n.slide ? [1] : []);
        });
        const sig = JSON.stringify(ph);
        if (!cur.bass.some(x => JSON.stringify(x) === sig)) cur.bass.push(ph);
      }
      cur.bass = cur.bass.slice(-24);
      used++;
      return;
    }
    if (role === 'fx' || !tr.notes.some(n => n.t < loopT)) return;
    const part = partKey(tr, role), L = cur.parts[part] || { bars: 0, c: new Array(16).fill(0), vs: new Array(16).fill(0) };
    for (let b = 0; b < src.bars; b++) {
      const hit = new Array(16).fill(0), vel = new Array(16).fill(0);
      tr.notes.forEach(n => {
        if (n.t < b * TPB || n.t >= (b + 1) * TPB) return;
        const i = clamp(Math.round((n.t - b * TPB) / 6), 0, 15);
        hit[i] = 1; vel[i] = Math.max(vel[i], n.vel || 0.85);
      });
      for (let i = 0; i < 16; i++) { L.c[i] += hit[i]; L.vs[i] += vel[i]; }
      L.bars++;
    }
    L.p = L.c.map(c => Math.round(c / L.bars * 100) / 100);
    L.v = L.c.map((c, i) => (c ? Math.round(L.vs[i] / c * 100) / 100 : 0.85));
    cur.parts[part] = L;
    used++;
  });
  if (!used) return null;
  cur.n++;
  GR.LEARN[key] = cur;
  return cur;
};
GR.forget = (genre, style) => { delete GR.LEARN[genre + ':' + style]; };
// a liked pattern gets picked more often, a skipped one less (the change is remembered by the app)
GR.rate = function (keys, up) {
  keys.filter(Boolean).forEach(k => {
    const w = GR.WEIGHTS[k] == null ? 1 : GR.WEIGHTS[k];
    GR.WEIGHTS[k] = Math.round(clamp(up ? w * 1.6 : w * 0.45, 0.1, 6) * 100) / 100;
  });
};
})();
