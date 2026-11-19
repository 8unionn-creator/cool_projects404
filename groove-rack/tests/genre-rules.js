// Groove Rack: genre rule tests for the pattern generator.
// Run with `node groove-rack/tests/genre-rules.js`. Every style of every genre is generated many times
// and checked against what makes the genre recognisable (the dembow, four on the floor, half-time snares...).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.join(__dirname, '..');
const ctx = { console, Math, JSON };
ctx.window = ctx;
vm.createContext(ctx);
['engine.js', 'presets.js', 'groove.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
const GR = ctx.GR, TPB = GR.TPB, RUNS = +(process.env.RUNS || 25);

let failed = 0, checks = 0;
const seen = {};
// failures are grouped by rule and style, with one example each
const fail = (what, info) => {
  failed++;
  const k = what.replace(/ \d bars (simple|medium|busy)/, '');
  if (!seen[k]) { seen[k] = 0; console.log('  FAIL ' + what + (info ? ' · ' + info : '')); }
  seen[k]++;
};
const step16 = n => Math.round((n.t % TPB) / (TPB / 16));
const inBar = (tr, b) => tr.notes.filter(n => n.t >= b * TPB && n.t < (b + 1) * TPB);
const role = tr => GR.roleOf(tr);
const hitsAt = (P, r, b, s, minVel) => P.tracks.some(t => role(t) === r && inBar(t, b).some(n => (n.t % TPB) === s * 6 && (minVel == null || n.vel >= minVel)));

const FOUR_ON_FLOOR = ['house:deep', 'house:tech', 'afrohouse:afrohouse', 'afrohouse:afrotech', 'amapiano:bacardi', 'reggaeton:dembow',
  'reggaeton:perreo', 'reggaeton:moombah', 'pop:dance', 'lofi:lofihouse', 'dancehall:soca'];
const BACKBEAT = ['pop:pop', 'pop:dance', 'pop:ballad', 'rnb:modern', 'rnb:neosoul', 'rnb:newjack', 'boombap:nineties', 'boombap:jazzy', 'boombap:hard',
  'lofi:chillhop', 'lofi:jazzhop', 'lofi:lofihouse', 'house:deep', 'house:tech', 'house:garage', 'afrohouse:afrohouse', 'afrohouse:afrotech', 'dnb:roller',
  'dnb:liquid', 'dnb:jungle', 'dancehall:modern', 'dancehall:soca', 'amapiano:bacardi', 'bounce:club', 'bounce:baltimore', 'bounce:nola', 'jersey:classic'];
const HALF_TIME = ['trap:atlanta', 'trap:rage', 'trap:melodic', 'drill:uk', 'drill:ny', 'drill:chicago', 'jersey:drill'];
const DEMBOW = ['reggaeton:dembow', 'reggaeton:perreo', 'reggaeton:moombah'];

for (const pr of GR.PRESETS) {
  const styles = GR.stylesOf(pr.id);
  if (styles.length < 2) fail(pr.id + ' has at least two styles');
  const [lo0, hi0] = styles[0].bpm;
  checks++; if (pr.bpm < lo0 || pr.bpm > hi0) fail(`${pr.id} starter tempo ${pr.bpm} sits in its first style's range ${lo0}-${hi0}`);
  for (const st of styles) {
    const key = pr.id + ':' + st.id, [lo, hi] = st.bpm;
    checks++; if (!(lo > 40 && hi < 240 && lo < hi)) fail(key + ' tempo range', st.bpm.join('-'));
    const g = GR.grooveOf(pr.id, st.id);
    for (const bars of [4, 8]) for (let cx = 0; cx < 3; cx++) for (let run = 0; run < RUNS; run++) {
      const P = GR.buildPreset(pr); P.bars = bars; P.chords = null; P.chordLock = false;
      P.tracks.forEach(t => { t.notes = []; });
      GR.generateAll(P, { genre: pr.id, style: st.id, complexity: cx });
      const tag = `${key} ${bars} bars ${['simple', 'medium', 'busy'][cx]}`;
      const body = Array.from({ length: bars }, (_, b) => b).filter(b => GR.phraseRole(b, bars) !== 'fill' && GR.phraseRole(b, bars) !== 'small');
      checks++;
      if (P.swing < g.swing[0] || P.swing > g.swing[1]) fail(tag + ' swing in range', P.swing);
      if (!Array.isArray(P.chords) || P.chords.length !== bars || P.chords.some(c => !c)) fail(tag + ' a chord on every bar');
      // feel: small offsets, nothing ahead of the very first beat
      P.tracks.forEach(t => t.notes.forEach(n => {
        if (n.nudge != null && (Math.abs(n.nudge) > 1.5 || (n.t === 0 && n.nudge < 0))) fail(tag + ' note timing within the feel', t.name + ' ' + n.t + ' ' + n.nudge);
      }));
      if (FOUR_ON_FLOOR.includes(key)) body.forEach(b => { checks++; if (![0, 4, 8, 12].every(s => hitsAt(P, 'kick', b, s))) fail(tag + ' four on the floor', 'bar ' + (b + 1)); });
      if (BACKBEAT.includes(key)) body.forEach(b => { checks++; if (!hitsAt(P, 'snare', b, 4, 0.6) || !hitsAt(P, 'snare', b, 12, 0.6)) fail(tag + ' backbeat on 2 and 4', 'bar ' + (b + 1)); });
      if (HALF_TIME.includes(key)) body.forEach(b => {
        checks++;
        if (!hitsAt(P, 'snare', b, 8, 0.6)) fail(tag + ' half-time snare on 3', 'bar ' + (b + 1));
        if (hitsAt(P, 'snare', b, 4, 0.6)) fail(tag + ' no full snare on 2 in half time', 'bar ' + (b + 1));
      });
      if (DEMBOW.includes(key)) Array.from({ length: bars }, (_, b) => b).forEach(b => { checks++; if (![3, 6, 11, 14].every(s => hitsAt(P, 'snare', b, s))) fail(tag + ' dembow 3-3-2 snare', 'bar ' + (b + 1)); });
      if (key === 'jersey:classic') body.forEach(b => {
        checks++;
        const k = P.tracks.filter(t => role(t) === 'kick').flatMap(t => inBar(t, b).filter(n => n.vel >= 0.6));
        if (![0, 4, 8].every(s => hitsAt(P, 'kick', b, s)) || k.length < 5) fail(tag + ' Jersey bounce kick', 'bar ' + (b + 1) + ': ' + k.length + ' kicks');
      });
      // phrases: the bars of the main idea repeat (A A . . | A A . .)
      P.tracks.filter(t => !['fx', 'bass', 'cymbal'].includes(role(t)) && t.notes.length).forEach(t => {
        checks++;
        const sig = b => inBar(t, b).map(n => n.t - b * TPB).join(',');
        const same = bars === 8 ? [0, 1, 4, 5] : [0, 1];
        if (same.some(b => sig(b) !== sig(0))) fail(tag + ' phrase repeats', t.name);
      });
      // bass: in key, on the chord's root at the top of the bar
      const sc = GR.SCALES[P.scale];
      P.tracks.filter(t => role(t) === 'bass').forEach(t => {
        t.notes.forEach(n => { checks++; if (sc.length >= 7 && !sc.includes(((n.p - P.key) % 12 + 12) % 12)) fail(tag + ' bass note in key', GR.noteName(n.p)); });
        for (let b = 0; b < bars; b++) {
          const first = inBar(t, b).find(n => n.t === b * TPB);
          checks++; if (first && ((first.p % 12) + 12) % 12 !== P.chords[b].r) fail(tag + ' bass on the root at the top of the bar', `bar ${b + 1} ${GR.noteName(first.p)} under ${GR.chordName(P.chords[b], P)}`);
        }
      });
    }
  }
}

// learning: a loop you teach shows up in what it generates
{
  const pr = GR.PRESETS.find(p => p.id === 'trap'), P = GR.buildPreset(pr);
  const kick = P.tracks.find(t => role(t) === 'kick');
  kick.notes = [];
  for (let b = 0; b < P.bars; b++) [0, 3, 6, 11].forEach(s => kick.notes.push({ t: b * TPB + s * 6, vel: 0.9 }));   // a kick no trap template has
  P.tracks.forEach(t => { if (t !== kick) t.notes = []; });
  for (let i = 0; i < 4; i++) GR.learnProject(P, 'trap', 'atlanta');
  let taught = 0;
  for (let run = 0; run < 60; run++) {
    const Q = GR.buildPreset(pr);
    GR.generateTrack(Q, Q.tracks.find(t => role(t) === 'kick'), { genre: 'trap', style: 'atlanta', complexity: 0 });
    const k = Q.tracks.find(t => role(t) === 'kick'), s = inBar(k, 0).map(step16);
    if ([3, 6, 11].every(x => s.includes(x))) taught++;
  }
  checks++; if (taught < 20) fail('a taught kick pattern comes back', taught + ' of 60');
  GR.forget('trap', 'atlanta');
  // a skipped pattern comes up less often
  const count = () => {
    let n = 0;
    for (let run = 0; run < 400; run++) {
      const Q = GR.buildPreset(pr), k = Q.tracks.find(t => role(t) === 'kick');
      GR.generateTrack(Q, k, { genre: 'trap', style: 'atlanta', complexity: 0 });
      if (GR.lastPicks[k.id] && GR.lastPicks[k.id].endsWith(JSON.stringify('X------xx-------'))) n++;
    }
    return n;
  };
  const before = count();
  for (let i = 0; i < 3; i++) GR.rate(['trap:atlanta:kick:' + JSON.stringify('X------xx-------')], false);
  const after = count();
  checks++; if (!(after < before * 0.5)) fail('a skipped pattern comes up less', before + ' -> ' + after);
  console.log(`learning: taught kick came back ${taught}/60 · skipped pattern ${before} -> ${after} of 400`);
}

Object.entries(seen).forEach(([k, n]) => { if (n > 1) console.log(`  ${n}× ${k}`); });
console.log(`${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
