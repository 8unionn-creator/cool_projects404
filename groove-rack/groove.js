/* Groove Rack — genre-aware pattern generator.
   Each genre has a vocabulary of real patterns per role (kick, snare, hats, percussion, bass rhythm).
   A new pattern starts from one of them and varies it: anchors (X) such as the backbeat never move,
   other hits can drop or move, new hits favour the strong steps, the last bar of the loop gets a fill,
   and the bass locks to the kick or plays the genre's bass rhythm over a chord progression in the key.
   Pattern strings use the same characters as presets.js: X anchor, x hit, o ghost, r/t/q roll, - rest. */
(function () {
'use strict';
const GR = window.GR, TPB = GR.TPB;

const ROLE = { kick: 'kick', snare: 'snare', clap: 'snare', snap: 'snare', rim: 'rim', hat: 'hat', openhat: 'openhat', cymbal: 'cymbal',
  tom: 'tom', shaker: 'shaker', conga: 'conga', bell: 'bell', block: 'block', fx: 'fx' };
GR.roleOf = tr => (GR.INST[tr.inst].pitched ? 'bass' : (ROLE[tr.inst] || 'perc'));

const FOUR = ['X---X---X---X---'];
const BACK = ['----X-------X---', '----X-------X--x', '----X--x----X---'];
// bass rhythms: [step, length in steps, scale degree above the chord root (7 = octave)]
const BASS = {
  tresillo: [[[0, 3, 0], [3, 3, 0], [6, 2, 4], [8, 3, 0], [11, 3, 0], [14, 2, 4]], [[0, 3, 0], [6, 2, 0], [10, 2, 4], [14, 2, 6]], [[0, 2, 0], [3, 1, 0], [6, 2, 4], [8, 2, 0], [11, 2, 7], [14, 2, 4]]],
  offbeat: [[[2, 2, 0], [6, 2, 0], [10, 2, 0], [14, 2, 0]], [[2, 2, 0], [6, 2, 7], [10, 2, 0], [14, 2, 4]], [[2, 1, 0], [3, 1, 0], [6, 2, 0], [10, 2, 7], [14, 2, 0]]],
  root8: [[[0, 2, 0], [2, 2, 0], [4, 2, 0], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 0], [14, 2, 0]], [[0, 3, 0], [3, 3, 0], [6, 2, 0], [8, 3, 0], [11, 3, 0], [14, 2, 0]], [[0, 2, 0], [2, 2, 0], [4, 2, 7], [6, 2, 0], [8, 2, 0], [10, 2, 0], [12, 2, 7], [14, 2, 4]]],
  log: [[[0, 2, 0], [3, 2, 0], [6, 2, 2], [10, 1, 7], [11, 2, 6], [14, 2, 4]], [[0, 2, 0], [3, 2, 0], [6, 2, 2], [10, 2, 0], [14, 2, 4]], [[0, 3, 0], [4, 1, 0], [6, 2, 4], [9, 2, 2], [12, 2, 0], [14, 2, 6]]],
  sparse: [[[0, 6, 0], [7, 2, 0], [10, 4, 4]], [[0, 4, 0], [7, 2, 0], [10, 3, 0], [14, 2, 6]], [[0, 7, 0], [8, 4, 4], [12, 3, 2]]],
  reese: [[[0, 8, 0], [10, 6, 0]], [[0, 6, 0], [8, 4, 2], [12, 4, 0]], [[0, 12, 0], [12, 4, 4]]]
};

const G = GR.GROOVES = {
  bounce: { name: 'Bounce', swing: [0, 0], hatRoll: 0.08, fxRate: 0.4, bass: { style: 'follow', slide: 0.25 },
    kick: ['X---X---X--x--x-', 'X---X---X-x---x-', 'X---X---X--x-x--', 'X---x---X--x--xx'],
    snare: BACK, 'clap': ['--o---o---o---o-', '----X-------X---', '--o---o---X---o-'],
    hat: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-', 'x-xxx-x-x-xxx-x-'], openhat: ['--x---x---x---x-', '------x-------x-', '--------------x-'],
    'fx:squeak': ['--------x-------', '----------x-----', '------x-----x---'], 'fx:reload': ['--------x-------', '----------x-----'], 'fx:shot': ['x---------------'] },
  afrobeats: { name: 'Afrobeats', swing: [25, 40], fxRate: 0.15, bass: { style: 'tresillo' },
    kick: ['X-----x---x-----', 'X-----x---x---x-', 'X--x--x---x-----', 'X-----x-x-----x-'],
    snare: ['----X-------X---', '--------X-------', '----X-------X--x'],
    rim: ['---x--x----x--x-', '--x--x----x--x--', '---x--x---x-x---'],
    shaker: ['oxoxoxoxoxoxoxox', 'oxxxoxxxoxxxoxxx', 'xoxoxoxoxoxoxoxo'], hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'],
    'conga:high': ['--x---xx--x---x-', '--x--x-x--x--xx-', '---x--x-x--x--x-'], 'conga:low': ['------x-------x-', '------x-----x-x-', '-------x------x-'],
    conga: ['--x---xx--x---x-', '---x--x-x--x--x-'], bell: ['x--x--x---x-x---', '--x--x-x--x--x-x', 'x-x--x-x-x--x-x-'], block: ['---x---x---x---x', '--x---x---x---x-'] },
  amapiano: { name: 'Amapiano', swing: [15, 28], fxRate: 0.1, bass: { style: 'log' },
    kick: ['X---X---X---X---', 'X---X---X---X---', 'X---X---X-------'], snare: ['----X-------X---', '--------X-------', '----x-------X--x'],
    shaker: ['xoxoxoxoxoxoxoxo', 'oxoxoxoxoxoxoxox', 'xxxoxxxoxxxoxxxo'], block: ['-x---x-x-x---x--', '--x--x---x-x--x-', '-x-x---x-x---x-x'],
    openhat: ['--x---x---x---x-'], hat: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'], rim: ['-x---x-x-x---x--', '---x---x--x---x-'] },
  afrohouse: { name: 'Afro House', swing: [10, 20], fxRate: 0.1, bass: { style: 'offbeat' },
    kick: FOUR, snare: ['----X-------X---', '----X-------X--x'], shaker: ['oxoxoxoxoxoxoxox', 'xoxoxoxoxoxoxoxo'],
    'conga:high': ['--x--x---x---x--', 'x--x--x---x--x--', '--x-x--x--x--x--'], 'conga:low': ['x------x--x-----', '---x------x---x-'],
    conga: ['--x--x---x---x--', 'x--x--x---x--x--'], rim: ['---x---x---x--x-', '--x---x---x-x---'], openhat: ['--x---x---x---x-'], hat: ['oooooooooooooooo'] },
  trap: { name: 'Trap', swing: [0, 0], hatRoll: 0.22, fxRate: 0.1, bass: { style: 'follow', slide: 0.3 },
    kick: ['X------x-x------', 'X------x--x---x-', 'X-----x---x-----', 'X--x---x-x------', 'X------xx-------'],
    snare: ['--------X-------', '--------X------x', '--------X-----x-'],
    hat: ['x-x-x-x-x-x-x-x-', 'xxx-x-x-xxx-x-x-', 'x-x-x-xxx-x-x-x-'], openhat: ['--------------x-', '------x-------x-', ''] },
  drill: { name: 'Drill', swing: [0, 0], hatRoll: 0.12, fxRate: 0.1, bass: { style: 'follow', slide: 0.6 },
    kick: ['X---------------', 'X---------x-----', 'X-----x---------', 'X--------x--x---'],
    snare: ['--------X-------', '-----o--X-----x-', '--------X--x----'],
    hat: ['x--x--x-xx--x--x--x-xx--', 'x--x--x--x--x--x-xx-x-xx', 'x-xx--x--x-xx--x--x--x--'], rim: ['--x--------x----', '------x-------x-'], openhat: ['', '--------------x-'] },
  pop: { name: 'Pop', swing: [0, 5], fxRate: 0.15, bass: { style: 'root8' },
    kick: ['X-------X-x-----', 'X-------X-------', 'X--x----X-x-----', 'X-----x-X-------'], snare: ['----X-------X---', '----X-------X--x'],
    hat: ['x-x-x-x-x-x-x-x-', 'xoxoxoxoxoxoxoxo'], openhat: ['--------------x-', '------x-------x-'], shaker: ['--x---x---x---x-', '----x-------x---'], 'fx:riser': ['x---------------'] },
  house: { name: 'House', swing: [5, 15], fxRate: 0.1, bass: { style: 'offbeat' },
    kick: FOUR, snare: ['----X-------X---', '----X-------X--x'], hat: ['oooooooooooooooo', '-o-o-o-o-o-o-o-o', 'oxoooxoooxoooxoo'], openhat: ['--x---x---x---x-'], shaker: ['oxoxoxoxoxoxoxox'] },
  reggaeton: { name: 'Reggaeton', swing: [0, 5], fxRate: 0.1, bass: { style: 'tresillo' },
    kick: FOUR, snare: ['---X--X----X--X-', '---X--X----X--x-', '---x--X----X--X-'], hat: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-'],
    conga: ['--x---x---x---xx', '-x---x-x-x---x--'], rim: ['---x--x----x--x-'] },
  dancehall: { name: 'Dancehall', swing: [5, 15], fxRate: 0.3, bass: { style: 'tresillo' },
    kick: ['X-----x-x-------', 'X-----x-x-----x-', 'X--x--x---x-----'], snare: ['----X-------X---'], rim: ['x--x--x-x--x--x-', 'x--x--x---x-x---'],
    hat: ['x-x-x-x-x-x-x-x-'], 'fx:airhorn': ['x---------------', 'x---x---x-------'] },
  boombap: { name: 'Boom Bap', swing: [50, 62], fxRate: 0.25, bass: { style: 'sparse' },
    kick: ['X-------x-x-----', 'X------xx-x-----', 'X-------x--x--x-', 'X-x-----x-x-----'], snare: ['----X-------X---', '----X-------X--o', '----X--o----X---'],
    hat: ['x-o-x-o-x-o-x-o-', 'x-x-x-x-x-x-x-x-', 'xox-xox-xox-xox-'], 'fx:scratch': ['------------x-x-', '--------x-x-----'] },
  rnb: { name: 'R&B', swing: [0, 10], hatRoll: 0.06, fxRate: 0.05, bass: { style: 'follow', slide: 0.15 },
    kick: ['X-------x--x----', 'X-------x--x--x-', 'X--x----x-------'], snare: ['----X-------X---'],
    hat: ['x---x---x---x-x-x---x---x---xxxx', 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-xxxx', 'x---x-x-x---x-x-x---x-x-x---xxx-'], shaker: ['--x---x---x---x-', '--x---x---x-x-x-'] },
  lofi: { name: 'Lo-fi', swing: [55, 65], fxRate: 0.05, bass: { style: 'sparse' },
    kick: ['X-------x-x-----', 'X------xx-------', 'X-------x--x----'], snare: ['----X-------X---'],
    hat: ['x-xox-x-x-xox-x-', 'x-x-x-x-x-x-x-x-', 'x--xx-x-x--xx-x-'], shaker: ['--x---x---x---x-'] },
  jersey: { name: 'Jersey Club', swing: [0, 0], hatRoll: 0.05, fxRate: 0.9, bass: { style: 'follow', slide: 0.1 },
    kick: ['X---x---x-x---x-', 'X---x---x-x-x-x-', 'X---x---xx-x--x-'], snare: ['----X-------X---', '----X-----x-X---'],
    hat: ['--x---x---x---x-'], 'fx:squeak': ['--x---x---x---x-', 'x-x---x-x-x---x-'] },
  dnb: { name: 'Drum & Bass', swing: [0, 5], fxRate: 0.1, bass: { style: 'reese' },
    kick: ['X---------x-----', 'X---------x--x--', 'X-x-------x-----'], snare: ['----X-------X---', '----X-------X--o', '----X--o----X---'],
    hat: ['x-x-x-x-x-x-x-x-', 'xoxoxoxoxoxoxoxo'], cymbal: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'] }
};
GR.GENRES = Object.keys(G);
const pick = a => a[Math.floor(Math.random() * a.length)];
const chance = p => Math.random() < p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function parse(s) {
  return Array.from(s).map(c => (c === '-' || c === '.') ? null : {
    vel: c === 'o' ? 0.42 : c === 'X' ? 1 : 0.9, roll: c === 'r' ? 2 : c === 't' ? 3 : c === 'q' ? 4 : 1, anchor: c === 'X'
  });
}
function templatesFor(g, tr, role) {
  return g[tr.inst + ':' + tr.sound] || (tr.inst !== role && g[tr.inst]) || g[role] || null;
}
// how strong a step is: 1 on the beat, 0.7 on the 8th, 0.35 elsewhere
function weight(i, n) { const per = n / 4; return i % per === 0 ? 1 : (Number.isInteger(per / 2) && i % (per / 2) === 0) ? 0.7 : 0.35; }

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
function fill(steps, role, g, cx) {
  const n = steps.length, per = n / 4, out = steps.map(s => s && Object.assign({}, s)), last = n - per;
  const put = (i, vel, roll) => { if (i >= 0 && i < n) out[i] = { vel, roll: roll || 1 }; };
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
function humanize(steps, role) {
  const n = steps.length;
  steps.forEach((s, i) => {
    if (!s) return;
    let v = s.vel * (0.94 + Math.random() * 0.12);
    if ((role === 'hat' || role === 'shaker') && weight(i, n) < 0.5) v *= 0.85;
    s.vel = Math.round(clamp(v, 0.05, 1) * 100) / 100;
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
  steps.forEach((s, i) => { if (s) { const n = { t: bar * TPB + i * st, vel: s.vel }; if (s.roll > 1) n.roll = s.roll; out.push(n); } });
  return out;
}
function hitsIn(P, roles, bar) {
  const set = new Set();
  P.tracks.forEach(t => { if (roles.includes(GR.roleOf(t))) t.notes.forEach(n => { if (n.t >= bar * TPB && n.t < (bar + 1) * TPB) set.add(n.t - bar * TPB); }); });
  return set;
}

/* ---------- drums ---------- */
function drumBars(P, tr, g, cx, bars) {
  const role = GR.roleOf(tr), tpl = templatesFor(g, tr, role);
  const avoidFor = b => (['kick', 'snare', 'hat', 'cymbal', 'openhat', 'fx'].includes(role) ? null : hitsIn(P, ['kick', 'snare'], b));
  const base = tpl ? parse(pick(tpl) || '----------------') : null;   // '' in a list means 'leave it out this time'
  const res = base ? base.length : (role === 'hat' ? 16 : 16);
  const A = base ? vary(base, role, g, cx) : null, B = A ? vary(A, role, g, Math.max(0, cx - 1)) : null;
  const out = {};
  const loop = P.bars;
  bars.forEach(b => {
    let steps;
    if (role === 'fx') {
      steps = (chance(g.fxRate || 0.2) || (b === bars[bars.length - 1] && !Object.values(out).some(x => x.some(s => s)))) && tpl
        ? vary(parse(pick(tpl)), role, g, cx) : new Array(res).fill(null);
    } else if (!A) {
      steps = role === 'cymbal' ? (b % 4 === 0 ? freeBar(role, g, cx, res) : new Array(res).fill(null))
        : role === 'tom' ? (b === loop - 1 ? fill(new Array(res).fill(null), role, g, cx) : new Array(res).fill(null))
        : freeBar(role, g, cx, res, avoidFor(b));
    } else if (b === loop - 1 && loop > 1 && bars.length > 1) steps = fill(A, role, g, cx);
    else steps = (b % 2 === 1 && chance(0.5)) ? B : A;
    out[b] = humanize(steps.map(s => s && Object.assign({}, s)), role);
  });
  return { res, out };
}

/* ---------- bass ---------- */
function progression(P) {
  const minor = GR.SCALES[P.scale][2] === 3;
  return pick(minor ? [[0, 0, 5, 4], [0, 5, 3, 4], [0, 3, 4, 0], [0, 6, 5, 4], [0, 0, 3, 5]] : [[0, 4, 5, 3], [0, 3, 4, 0], [0, 5, 3, 4], [0, 3, 0, 4]]);
}
function bassRoot(P, tr) {
  const lo = GR.INST[tr.inst].id === 'bass' ? 28 : 26;
  let r = P.key; while (r < lo) r += 12; return r;
}
function degreeToPitch(P, root, chordDeg, d) {
  const sc = GR.SCALES[P.scale], i = chordDeg + d;
  return root + sc[((i % sc.length) + sc.length) % sc.length] + 12 * Math.floor(i / sc.length);
}
function bassNotes(P, tr, g, cx, bars, kickNotes) {
  const style = (tr.inst === 'logdrum' && g.bass.style !== 'follow') ? 'log' : g.bass.style;
  const prog = progression(P), root = bassRoot(P, tr), stepT = TPB / 16, notes = [];
  const rhythmA = style === 'follow' ? null : pick(BASS[style]), rhythmB = style === 'follow' ? null : pick(BASS[style]);
  bars.forEach(b => {
    const chordDeg = prog[b % prog.length], b0 = b * TPB;
    let rhythm;
    if (style === 'follow') {
      let hits = kickNotes.filter(n => n.t >= b0 && n.t < b0 + TPB).map(n => Math.round((n.t - b0) / stepT));
      if (!hits.length) hits = parse(pick(g.kick)).map((s, i) => (s ? i : -1)).filter(i => i >= 0);
      hits = [...new Set(hits)].sort((a, c) => a - c);
      rhythm = hits.map((s, i) => {
        const next = i + 1 < hits.length ? hits[i + 1] : 16;
        const d = i === 0 ? 0 : pick([0, 0, 0, 0, 7, 4, 6, 2].slice(0, 4 + cx * 2));
        return [s, clamp(next - s, 1, 8), d];
      });
    } else rhythm = (b % 2 === 1 && chance(0.4 + 0.2 * cx)) ? rhythmB : rhythmA;
    rhythm.forEach(([s, len, d], i) => {
      if (i > 0 && cx === 0 && d !== 0 && chance(0.5)) d = 0;
      else if (i > 0 && style !== 'follow' && chance(0.15 * cx)) d = pick([0, 4, 7, 6, 2]);   // a passing note, still in the key
      const n = { t: b0 + s * stepT, len: len * stepT, p: degreeToPitch(P, root, chordDeg, d), vel: Math.round((i === 0 ? 0.9 : 0.8 + Math.random() * 0.1) * 100) / 100 };
      if (g.bass.slide && i > 0 && GR.INST[tr.inst].mono && chance(g.bass.slide * (0.5 + cx * 0.4))) n.slide = true;
      notes.push(n);
    });
  });
  return notes;
}

/* ---------- public ---------- */
// opts: { genre, complexity 0-2, bar: number (just that bar) or null (the whole loop) }
GR.generateTrack = function (P, tr, opts) {
  const g = G[opts.genre] || G.trap, cx = clamp(opts.complexity == null ? 1 : opts.complexity, 0, 2);
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
  const g = G[opts.genre] || G.trap, firstOfRole = {};
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
      return;
    }
    GR.generateTrack(P, tr, opts);
    if (!first) firstOfRole[role] = tr;
  });
  if (opts.bar == null) P.swing = Math.round(g.swing[0] + Math.random() * (g.swing[1] - g.swing[0]));
};
})();
