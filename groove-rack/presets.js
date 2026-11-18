/* Groove Rack — genre starting points.
   Drum bars are strings, one character per step (the string length sets the steps per bar):
     x hit   X accent   o ghost (soft)   r t q  roll of 2, 3 or 4 inside the step   - rest
   Melodic bars are tokens "step:note:length" (length in steps), e.g. "0:F#1:4".
   A trailing ~ slides into the note. A chord is "step:Am7@4:length" (chord @ octave). */
(function () {
'use strict';
const GR = window.GR;
const TPB = GR.TPB;

const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function parseNote(s) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s); if (!m) return null;
  return NOTE_IDX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (parseInt(m[3], 10) + 1) * 12;
}
const CHORDS = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], add9: [0, 4, 7, 14], sus2: [0, 2, 7], sus4: [0, 5, 7],
  dim: [0, 3, 6], '9': [0, 4, 7, 10, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9]
};
function chord(sym, oct) {
  const m = /^([A-G])(#|b)?(.*)$/.exec(sym);
  const root = parseNote(m[1] + (m[2] || '') + oct);
  return (CHORDS[m[3]] || CHORDS['']).map(i => root + i);
}
GR.chord = chord;

const VEL = { x: 0.9, X: 1, o: 0.42, r: 0.85, t: 0.85, q: 0.85 };
const ROLL = { r: 2, t: 3, q: 4 };
function drumNotes(bars, nBars) {
  const notes = []; let res = 16;
  for (let b = 0; b < nBars; b++) {
    const s = bars[b % bars.length]; if (!s) continue;
    res = s.length; const st = TPB / res;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]; if (!(c in VEL)) continue;
      const n = { t: b * TPB + i * st, vel: VEL[c] }; if (ROLL[c]) n.roll = ROLL[c];
      notes.push(n);
    }
  }
  const first = bars.find(s => s); if (first) res = first.length;
  return { notes, res };
}
function melNotes(bars, nBars, res) {
  const notes = [], st = TPB / res;
  for (let b = 0; b < nBars; b++) {
    const s = bars[b % bars.length]; if (!s) continue;
    s.trim().split(/\s+/).forEach(tok => {
      const [step, what, len] = tok.split(':');
      const slide = len.endsWith('~');
      const base = { t: b * TPB + parseFloat(step) * st, len: parseFloat(len) * st, vel: 0.85 };
      if (what.includes('@')) {
        const [sym, oct] = what.split('@');
        chord(sym, +oct).forEach(p => notes.push(Object.assign({ p }, base, { vel: 0.7 })));
      } else {
        const n = Object.assign({ p: parseNote(what) }, base); if (slide) n.slide = true; notes.push(n);
      }
    });
  }
  return notes;
}
// helpers that write repetitive melodic bars
const stab = (chs, steps, len, oct) => chs.map(c => steps.map(s => `${s}:${c}@${oct || 4}:${len}`).join(' '));
const hold = (chs, oct, len) => chs.map(c => `0:${c}@${oct}:${len || 16}`);
const arp = (chs, oct, order, every, len) => chs.map(c => {
  const ns = chord(c, oct);
  return order.map((o, i) => `${i * every}:${GR.noteName(ns[o % ns.length] + 12 * Math.floor(o / ns.length)).replace('#', '#')}:${len || every}`).join(' ');
});
const line = (roots, steps, lens) => roots.map(r => steps.map((s, i) => `${s}:${r}:${lens[i % lens.length]}`).join(' '));

const D = (inst, sound, pat, x) => Object.assign({ inst, sound, drum: pat }, x);
const M = (inst, sound, pat, x) => Object.assign({ inst, sound, mel: pat }, x);

GR.PRESETS = [
  { id: 'bounce', name: 'Bounce', mood: 'Club bounce with squeaks and a reload', bpm: 150, swing: 0, bars: 8, key: 6, scale: 'minor', tracks: [
    D('kick', 'bounce', ['x---x---x--x--x-'], { vol: 0.85 }),
    D('clap', 'clap', ['--o---o---o---o-'], { vol: 0.7 }),
    D('snap', 'snap', ['', '', '----x-------x---', '----x-------x---', '----x-------x---', '----x-------x---', '----x-------x---', '----x-------x-x-'], { rev: 0.15 }),
    D('openhat', 'open', ['', '', '', '', '--x---x---x---x-'], { vol: 0.55, name: 'Open Hat' }),
    M('b808', 'dirty', ['0:F#1:4 4:F#1:4 8:F#1:3 11:A1:3 14:C#2:2', '0:E1:4 4:E1:4 8:E1:3 11:G#1:3 14:B1:2'], { vol: 0.8 }),
    M('vox', 'ah', ['0:C#5:2 3:C#5:1 6:E5:2 10:F#5:2 13:E5:3', '0:B4:2 3:B4:1 6:C#5:2 10:E5:2 13:C#5:3'], { vol: 0.6, rev: 0.3, echo: 0.25 }),
    D('fx', 'squeak', ['', '--------x-------', '', '----------x-----', '', '----------x-----', '', '--------x-------'], { name: 'Squeak', vol: 0.6 }),
    D('fx', 'reload', ['', '--------x-------', '', '', '', '----------x-----', '', ''], { name: 'Reload', vol: 0.75 }),
    D('fx', 'shot', ['', '', '', '', 'x---------------', '', '', ''], { name: 'Shot', vol: 0.7, rev: 0.2 })
  ] },
  { id: 'afrobeats', name: 'Afrobeats', mood: 'Swung shakers, congas and highlife guitar', bpm: 104, swing: 32, bars: 4, key: 7, scale: 'minor', tracks: [
    D('kick', 'afro', ['x-----x---x-----', 'x-----x---x-----', 'x-----x---x-----', 'x-----x---x---x-']),
    D('rim', 'rim', ['---x--x----x--x-'], { vol: 0.55 }),
    D('clap', 'clap', ['----x-------x---'], { vol: 0.55, rev: 0.2 }),
    D('shaker', 'shaker', ['oxoxoxoxoxoxoxox'], { vol: 0.55, pan: 0.25 }),
    D('conga', 'high', ['--x---xx--x---x-'], { vol: 0.6, pan: -0.3, name: 'Conga Hi' }),
    D('conga', 'low', ['------x-------x-', '------x-----x-x-'], { vol: 0.65, pan: -0.15, name: 'Conga Lo' }),
    D('bell', 'agogo', ['x--x--x---x-x---'], { vol: 0.32, pan: 0.35 }),
    M('bass', 'round', ['0:G1:3 6:G1:2 10:D2:2 14:F1:2', '0:C2:3 6:C2:2 10:G1:2 14:Bb1:2', '0:F1:3 6:F1:2 10:C2:2 14:A1:2', '0:Bb1:3 6:Bb1:2 10:F1:2 12:A1:2 14:F1:2'], { vol: 0.75 }),
    M('keys', 'rhodes', stab(['Gm7', 'Cm7', 'F', 'Bbmaj7'], [2, 6, 10, 13], 2), { vol: 0.5, rev: 0.25 }),
    M('pluck', 'guitar', arp(['Gm', 'Cm', 'F', 'Bb'], 4, [0, 2, 1, 3, 2, 1, 4, 2], 2), { vol: 0.5, pan: 0.2, echo: 0.15, name: 'Guitar' }),
    M('vox', 'oh', ['', '12:D5:4', '', '10:F5:2 12:D5:4'], { vol: 0.5, rev: 0.35, echo: 0.3 })
  ] },
  { id: 'amapiano', name: 'Amapiano', mood: 'Log drum bass, jazzy piano, shakers', bpm: 113, swing: 22, bars: 4, key: 5, scale: 'minor', tracks: [
    D('kick', 'house', ['x---x---x---x---'], { vol: 0.75 }),
    D('clap', 'clap', ['----x-------x---'], { vol: 0.5, rev: 0.2 }),
    D('shaker', 'shaker', ['xoxoxoxoxoxoxoxo'], { vol: 0.5, pan: 0.2 }),
    D('block', 'tick', ['-x---x-x-x---x--'], { vol: 0.45, pan: -0.25 }),
    D('openhat', 'short', ['--x---x---x---x-'], { vol: 0.35 }),
    M('logdrum', 'log', ['0:F1:2 3:F1:2 6:Ab1:2 10:F2:1 11:Eb2:2 14:C2:2', '0:Bb1:2 3:Bb1:2 6:Db2:2 10:Bb1:1 11:F2:2 14:Db2:2', '0:Db2:2 3:Db2:2 6:F2:2 10:Ab1:2 14:Eb2:2', '0:Eb2:2 3:Eb2:2 6:G1:2 10:Bb1:1 11:C2:2 13:Eb2:3'], { vol: 0.8 }),
    M('keys', 'piano', stab(['Fm9', 'Bbm9', 'Dbmaj7', 'Eb'], [0, 6, 10], 3), { vol: 0.5, rev: 0.3 }),
    M('pad', 'warm', hold(['Fm', 'Bbm', 'Db', 'Eb'], 3), { vol: 0.35, rev: 0.4 }),
    M('vox', 'ee', ['', '8:C5:2 11:Ab4:4', '', '8:Eb5:2 11:C5:4'], { vol: 0.45, rev: 0.4, echo: 0.3 })
  ] },
  { id: 'afrohouse', name: 'Afro House', mood: 'Four on the floor with congas and chants', bpm: 122, swing: 15, bars: 4, key: 2, scale: 'minor', tracks: [
    D('kick', 'house', ['x---x---x---x---']),
    D('clap', 'clap', ['----x-------x---'], { vol: 0.5, rev: 0.25 }),
    D('shaker', 'shaker', ['oxoxoxoxoxoxoxox'], { vol: 0.5, pan: 0.3 }),
    D('conga', 'high', ['--x--x---x---x--'], { vol: 0.55, pan: -0.35, name: 'Conga Hi' }),
    D('conga', 'low', ['x------x--x-----'], { vol: 0.6, pan: -0.15, name: 'Conga Lo' }),
    D('rim', 'rim', ['---x---x---x--x-'], { vol: 0.4, pan: 0.2 }),
    D('openhat', 'open', ['--x---x---x---x-'], { vol: 0.35 }),
    M('bass', 'pluck', line(['D2', 'Bb1', 'F2', 'C2'], [2, 6, 10, 14], [2]), { vol: 0.7 }),
    M('pad', 'strings', hold(['Dm7', 'Bbmaj7', 'Fmaj7', 'C'], 3), { vol: 0.35, rev: 0.5 }),
    M('vox', 'ah', ['0:A4:3 4:D5:2 7:C5:3 12:A4:2', '0:F4:3 4:Bb4:2 7:A4:3', '0:A4:3 4:D5:2 7:F5:3 12:E5:2', '0:E5:3 4:D5:2 7:C5:6'], { vol: 0.45, rev: 0.45, echo: 0.3 })
  ] },
  { id: 'trap', name: 'Trap', mood: 'Hat rolls, sliding 808, dark bells', bpm: 140, swing: 0, bars: 4, key: 0, scale: 'minor', tracks: [
    D('kick', 'punch', ['x------x-x------', 'x------x--x---x-', 'x------x-x------', 'x---x--x--x-x---']),
    D('clap', 'big', ['--------x-------'], { vol: 0.75, rev: 0.15 }),
    D('snare', 'trap', ['--------x-------'], { vol: 0.45 }),
    D('hat', 'tight', ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-xtx-x-', 'x-x-x-x-x-x-x-x-', 'x-x-x-xrx-x-rrrr'], { vol: 0.55, pan: 0.15 }),
    D('openhat', 'short', ['', '--------------x-'], { vol: 0.4 }),
    M('b808', 'slide', ['0:C2:6 7:C2:2 9:G1:6', '0:C2:6 7:Eb2:3 10:Bb1:4 14:C2:2~', '0:Ab1:6 7:Ab1:2 9:Eb2:6', '0:G1:4 4:G1:3 7:G1:2 10:Bb1:2 12:D2:4~'], { vol: 0.8 }),
    M('pluck', 'bell', ['0:C5:2 2:Eb5:2 4:G5:2 6:Eb5:2 8:D5:2 10:Bb4:2 12:G4:4', '0:C5:2 2:Eb5:2 4:G5:2 6:Ab5:2 8:G5:2 10:Eb5:2 12:D5:4', '0:Ab4:2 2:C5:2 4:Eb5:2 6:C5:2 8:G5:4 12:F5:2 14:Eb5:2', '0:D5:2 2:B4:2 4:G4:2 6:B4:2 8:D5:4 12:F5:4'], { vol: 0.45, rev: 0.35, echo: 0.2 }),
    M('pad', 'strings', hold(['Cm', 'Cm', 'Ab', 'G'], 3), { vol: 0.25, rev: 0.4 })
  ] },
  { id: 'drill', name: 'Drill', mood: 'Triplet hats, off-grid snares, big slides', bpm: 142, swing: 0, bars: 4, key: 6, scale: 'minor', tracks: [
    D('kick', 'boom', ['x---------------', 'x---------x-----'], { vol: 0.7 }),
    D('snare', 'trap', ['--------x-------', '-----o--x-----x-'], { vol: 0.7, rev: 0.1 }),
    D('hat', 'crisp', ['x--x--x-xx--x--x--x-xx--', 'x--x--x--x--x--x-xx-x-xx'], { vol: 0.45, pan: 0.2 }),
    D('rim', 'rim', ['--x--------x----'], { vol: 0.35, pan: -0.3 }),
    M('b808', 'slide', ['0:F#1:6 6:F#1:2 8:A1:4~ 12:C#2:4~', '0:B1:6 6:B1:2 8:D2:4~ 12:C#2:4~', '0:F#1:6 6:F#1:2 8:A1:4~ 12:C#2:4~', '0:D2:6 6:D2:2 8:C#2:8~'], { vol: 0.85 }),
    M('pad', 'strings', ['0:F#m@4:16', '0:Bm@4:16', '0:F#m@4:16', '0:D@4:8 8:C#@4:8'], { vol: 0.3, rev: 0.4 }),
    M('pluck', 'bell', ['0:C#6:3 3:A5:3 6:F#5:2 8:G#5:6', '0:D6:3 3:B5:3 6:F#5:2 8:A5:6', '0:C#6:3 3:A5:3 6:F#5:2 8:G#5:6', '0:A5:3 3:F#5:3 6:D5:2 8:F5:6'], { vol: 0.4, rev: 0.35, echo: 0.25 })
  ] },
  { id: 'pop', name: 'Pop', mood: 'Four-chord anthem with a supersaw', bpm: 118, swing: 0, bars: 4, key: 0, scale: 'major', tracks: [
    D('kick', 'punch', ['x-------x-x-----', 'x-------x-x-----', 'x-------x-x-----', 'x-------x-x--x--']),
    D('clap', 'clap', ['----x-------x---'], { vol: 0.65, rev: 0.25 }),
    D('snare', 'tight', ['----x-------x---'], { vol: 0.4 }),
    D('hat', 'crisp', ['x-x-x-x-x-x-x-x-'], { vol: 0.4, pan: 0.2 }),
    D('openhat', 'open', ['', '', '', '--------------x-'], { vol: 0.4 }),
    M('bass', 'synth', line(['C2', 'G1', 'A1', 'F1'], [0, 2, 4, 6, 8, 10, 12, 14], [2]), { vol: 0.65 }),
    M('pad', 'supersaw', hold(['C', 'G', 'Am', 'F'], 4), { vol: 0.35, rev: 0.35 }),
    M('pluck', 'pluck', ['0:E5:2 2:G5:2 4:C6:3 8:B5:2 10:G5:2 12:E5:4', '0:D5:2 2:G5:2 4:B5:3 8:A5:2 10:G5:2 12:D5:4', '0:C5:2 2:E5:2 4:A5:3 8:G5:2 10:E5:2 12:C5:4', '0:C5:2 2:F5:2 4:A5:3 8:G5:2 10:F5:2 12:E5:2 14:D5:2'], { vol: 0.5, echo: 0.3, rev: 0.2, name: 'Lead' }),
    M('vox', 'yeah', ['', '8:G5:6', '', '8:A5:6'], { vol: 0.4, rev: 0.4 }),
    D('fx', 'riser', ['', '', '', 'x---------------'], { vol: 0.4, name: 'Riser' })
  ] },
  { id: 'house', name: 'House', mood: 'Offbeat hats and organ stabs', bpm: 124, swing: 10, bars: 4, key: 9, scale: 'minor', tracks: [
    D('kick', 'house', ['x---x---x---x---']),
    D('clap', 'clap', ['----x-------x---'], { vol: 0.6, rev: 0.25 }),
    D('hat', 'soft', ['oooooooooooooooo'], { vol: 0.5, pan: -0.2 }),
    D('openhat', 'open', ['--x---x---x---x-'], { vol: 0.45, pan: 0.15 }),
    M('bass', 'pluck', line(['A1', 'A1', 'F1', 'G1'], [2, 6, 10, 14], [2]), { vol: 0.7 }),
    M('keys', 'organ', stab(['Am7', 'Am7', 'Fmaj7', 'G'], [3, 6, 11, 14], 1), { vol: 0.45, rev: 0.3, echo: 0.2 }),
    M('vox', 'ah', ['', '', '', '0:E5:4 6:C5:2 8:A4:6'], { vol: 0.4, rev: 0.4, echo: 0.3 })
  ] },
  { id: 'reggaeton', name: 'Reggaeton', mood: 'Dembow rhythm, plucked chords', bpm: 94, swing: 0, bars: 4, key: 9, scale: 'minor', tracks: [
    D('kick', 'punch', ['x---x---x---x---'], { vol: 0.8 }),
    D('snare', 'tight', ['---x--x----x--x-'], { vol: 0.6 }),
    D('hat', 'tight', ['x-x-x-x-x-x-x-x-'], { vol: 0.35, pan: 0.2 }),
    D('conga', 'bongo', ['--x---x---x---xx'], { vol: 0.35, pan: -0.3 }),
    M('bass', 'synth', line(['A1', 'F1', 'C2', 'G1'], [0, 3, 6, 8, 11, 14], [3, 3, 2]), { vol: 0.65 }),
    M('pluck', 'guitar', stab(['Am', 'F', 'C', 'G'], [0, 3, 6, 8, 11, 14], 2, 4), { vol: 0.45, rev: 0.2, name: 'Guitar' }),
    M('vox', 'hey', ['', '', '', '12:A4:1'], { vol: 0.5, rev: 0.2 })
  ] },
  { id: 'dancehall', name: 'Dancehall', mood: 'Skank chords, tresillo rim, air horn', bpm: 100, swing: 8, bars: 4, key: 7, scale: 'minor', tracks: [
    D('kick', 'punch', ['x-----x-x-------', 'x-----x-x-----x-'], { vol: 0.8 }),
    D('snare', 'fat', ['----x-------x---'], { vol: 0.6, rev: 0.15 }),
    D('rim', 'rim', ['x--x--x-x--x--x-'], { vol: 0.35, pan: -0.25 }),
    D('hat', 'tight', ['x-x-x-x-x-x-x-x-'], { vol: 0.35, pan: 0.25 }),
    M('bass', 'round', ['0:G1:3 3:G1:3 6:Bb1:2 8:C2:3 11:C2:3 14:D2:2', '0:Eb1:3 3:Eb1:3 6:G1:2 8:Bb1:3 11:Bb1:3 14:C2:2', '0:Bb1:3 3:Bb1:3 6:D2:2 8:F1:3 11:F1:3 14:A1:2', '0:F1:3 3:F1:3 6:A1:2 8:D2:3 11:D2:3 14:F2:2'], { vol: 0.7 }),
    M('keys', 'organ', stab(['Gm', 'Eb', 'Bb', 'F'], [2, 6, 10, 14], 1), { vol: 0.4, rev: 0.2 }),
    D('fx', 'airhorn', ['x---------------', '', 'x---x---x-------', ''], { vol: 0.35, rev: 0.25, name: 'Air Horn' })
  ] },
  { id: 'boombap', name: 'Boom Bap', mood: 'Dusty swung drums and jazzy rhodes', bpm: 90, swing: 55, bars: 4, key: 2, scale: 'minor', tracks: [
    D('kick', 'dusty', ['x-------x-x-----', 'x------xx-x-----', 'x-------x-x-----', 'x------x--x--x--']),
    D('snare', 'fat', ['----x-------x---', '----x-------x--o'], { vol: 0.65, rev: 0.15 }),
    D('hat', 'soft', ['x-o-x-o-x-o-x-o-'], { vol: 0.5, pan: 0.2 }),
    M('keys', 'rhodes', hold(['Dm9', 'Gm7', 'Bbmaj7', 'A7'], 4, 12), { vol: 0.5, rev: 0.3, tone: 0.75 }),
    M('bass', 'round', line(['D2', 'G1', 'Bb1', 'A1'], [0, 7, 10], [4, 2, 3]), { vol: 0.7, tone: 0.7 }),
    D('fx', 'scratch', ['', '', '', '------------x-x-'], { vol: 0.5, name: 'Scratch' })
  ] },
  { id: 'rnb', name: 'R&B', mood: 'Slow and smooth with 32nd hats', bpm: 72, swing: 0, bars: 4, key: 3, scale: 'major', tracks: [
    D('kick', 'afro', ['x-------x--x----', 'x-------x--x--x-'], { vol: 0.75 }),
    D('snap', 'snap', ['----x-------x---'], { vol: 0.7, rev: 0.35 }),
    D('hat', 'tight', ['x---x---x---x-x-x---x---x---xxxx', 'x---x---x-x-x---x---x---x-xxx-x-'], { vol: 0.4, pan: 0.2 }),
    M('b808', 'clean', line(['Eb1', 'C1', 'Ab1', 'Bb1'], [0, 10, 14], [8, 4, 2]), { vol: 0.7 }),
    M('keys', 'rhodes', hold(['Ebmaj7', 'Cm9', 'Abmaj7', 'Bbsus4'], 4), { vol: 0.5, rev: 0.35 }),
    M('pad', 'warm', hold(['Eb', 'Cm', 'Ab', 'Bb'], 3), { vol: 0.25, rev: 0.5 }),
    M('vox', 'oo', ['4:G5:4 8:Bb5:2 10:G5:6', '4:G5:4 8:F5:2 10:Eb5:6', '4:C6:4 8:Bb5:2 10:Ab5:6', '4:G5:4 8:F5:8'], { vol: 0.45, rev: 0.45, echo: 0.3 })
  ] },
  { id: 'lofi', name: 'Lo-fi', mood: 'Lazy swing, warm and filtered', bpm: 80, swing: 60, bars: 4, key: 0, scale: 'major', tracks: [
    D('kick', 'dusty', ['x-------x-x-----', 'x------xx-------']),
    D('snare', 'lofi', ['----x-------x---'], { vol: 0.6, rev: 0.25 }),
    D('hat', 'soft', ['x-xox-x-x-xox-x-'], { vol: 0.45, pan: 0.2 }),
    D('shaker', 'cabasa', ['--x---x---x---x-'], { vol: 0.35, pan: -0.3 }),
    M('keys', 'rhodes', stab(['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], [0, 8], 7), { vol: 0.5, rev: 0.35, tone: 0.65 }),
    M('bass', 'round', line(['F1', 'E1', 'D1', 'C1'], [0, 8, 12], [6, 4, 3]), { vol: 0.7, tone: 0.6 }),
    M('pluck', 'kalimba', ['', '0:A5:2 2:G5:2 4:E5:4', '', '0:E5:2 2:D5:2 4:C5:4'], { vol: 0.35, echo: 0.35, rev: 0.3 })
  ] },
  { id: 'jersey', name: 'Jersey Club', mood: 'Bed squeaks and triplet kicks', bpm: 140, swing: 0, bars: 4, key: 9, scale: 'minor', tracks: [
    D('kick', 'bounce', ['x---x---x-x---x-', 'x---x---x-x-x-x-']),
    D('clap', 'tight', ['----x-------x---'], { vol: 0.7, rev: 0.15 }),
    D('hat', 'tight', ['--x---x---x---x-'], { vol: 0.35 }),
    D('fx', 'squeak', ['--x---x---x---x-'], { vol: 0.45, name: 'Squeak' }),
    M('vox', 'hey', ['', '4:A4:1 12:A4:1', '', '4:A4:1 10:A4:1 12:A4:1'], { vol: 0.55 }),
    M('b808', 'clean', line(['A1', 'F1', 'C2', 'G1'], [0, 4, 8, 10, 14], [4, 4, 2, 4, 2]), { vol: 0.7 }),
    M('pluck', 'pluck', ['0:A5:1 2:C6:1 4:E6:2 8:C6:1 10:A5:2', '0:A5:1 2:C6:1 4:F6:2 8:C6:1 10:A5:2'], { vol: 0.4, echo: 0.3 })
  ] },
  { id: 'dnb', name: 'Drum & Bass', mood: 'Fast breakbeat with a reese bass', bpm: 174, swing: 0, bars: 4, key: 4, scale: 'minor', tracks: [
    D('kick', 'punch', ['x---------x-----', 'x---------x--x--']),
    D('snare', 'tight', ['----x-------x---', '----x-------x--o'], { vol: 0.75, rev: 0.15 }),
    D('hat', 'crisp', ['x-x-x-x-x-x-x-x-'], { vol: 0.35, pan: 0.2 }),
    D('cymbal', 'ride', ['--x---x---x---x-'], { vol: 0.25, pan: -0.25 }),
    M('bass', 'reese', line(['E1', 'C1', 'G1', 'D1'], [0, 8, 12], [6, 3, 4]), { vol: 0.65 }),
    M('pad', 'warm', hold(['Em', 'C', 'G', 'D'], 4), { vol: 0.3, rev: 0.5 })
  ] }
];

// default names when a track has none
function defaultName(t) {
  const inst = GR.INST[t.inst];
  if (t.inst === 'fx') { const l = inst.sounds[t.sound][0]; return l[0].toUpperCase() + l.slice(1); }
  return inst.label;
}
let idn = 1;
GR.newId = () => 't' + Date.now().toString(36) + (idn++).toString(36);
GR.newTrack = function (inst, sound, x) {
  const I = GR.INST[inst];
  const t = Object.assign({
    id: GR.newId(), inst, sound: sound || I.def, group: I.group, res: 16,
    vol: 0.8, pan: 0, tone: 1, rev: 0, echo: 0, pitch: 0, decay: 1,
    mute: false, solo: false, sample: null, sampleName: null, notes: []
  }, x || {});
  if (!t.name) t.name = defaultName(t);
  t.low = t.low != null ? t.low : (I.base != null ? I.base : 48);
  return t;
};
GR.buildPreset = function (pr) {
  const P = { v: 1, name: pr.name + ' beat', bpm: pr.bpm, swing: pr.swing, bars: pr.bars, key: pr.key, scale: pr.scale, master: 0.8, tracks: [] };
  pr.tracks.forEach(d => {
    const x = Object.assign({}, d); delete x.drum; delete x.mel;
    const t = GR.newTrack(d.inst, d.sound, x);
    if (d.drum) { const r = drumNotes(d.drum, pr.bars); t.notes = r.notes; t.res = r.res; }
    else {
      t.res = 16; t.notes = melNotes(d.mel, pr.bars, 16);
      const ps = t.notes.map(n => n.p);
      if (ps.length) { const mid = (Math.min(...ps) + Math.max(...ps)) / 2; t.low = Math.round(mid - 12); }
    }
    P.tracks.push(t);
  });
  return P;
};
GR.emptyProject = function () {
  return {
    v: 1, name: 'New beat', bpm: 120, swing: 0, bars: 4, key: 9, scale: 'minor', master: 0.8,
    tracks: [
      GR.newTrack('kick', 'punch'), GR.newTrack('snare', 'tight'), GR.newTrack('clap', 'clap'),
      GR.newTrack('hat', 'tight'), GR.newTrack('openhat', 'open', { name: 'Open Hat' }),
      GR.newTrack('b808', 'clean'), GR.newTrack('keys', 'piano', { low: 54 }), GR.newTrack('vox', 'ah')
    ]
  };
};
})();
