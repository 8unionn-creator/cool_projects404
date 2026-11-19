// Renders every built-in Groove Rack sound to plugin/kit/<inst>_<sound>.wav (44.1 kHz mono, 16-bit)
// and the default project to plugin/kit/default-project.json, using the web app's own synth engine.
// Run from the repo:  node groove-rack/plugin/tools/render-kit.js   (needs Playwright + Chromium)
// Add --project-only to rewrite only default-project.json.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), http = require('http');
const root = path.resolve(__dirname, '../..'), out = path.resolve(__dirname, '../kit');
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200); res.end(d); } });
}).listen(0);
(async () => {
  const b = await chromium.launch(), p = await b.newPage();
  await p.goto(`http://localhost:${server.address().port}/index.html`);
  await p.waitForFunction(() => window.GR && GR.app);
  const projectOnly = process.argv.includes('--project-only');
  const result = await p.evaluate(async (projectOnly) => {
    const SR = 44100, files = {};
    if (projectOnly) return { files, project: JSON.stringify(GR.pluginProject(GR.buildPreset(GR.PRESETS[0]))) };
    for (const inst of Object.values(GR.INST)) {
      for (const sound of Object.keys(inst.sounds)) {
        const secs = inst.pitched ? 3.2 : 3;
        const ctx = new OfflineAudioContext(1, SR * secs, SR);
        const tr = { inst: inst.id, sound, pitch: 0, decay: 1 };
        GR.voice(ctx, ctx.destination, 0, tr, { vel: 1, p: inst.pitched ? GR.KIT_ROOT : 60, dur: inst.pitched ? 3.0 : 0.1, from: null });
        const d = (await ctx.startRendering()).getChannelData(0);
        let end = d.length; while (end > 1 && Math.abs(d[end - 1]) < 0.0003) end--;
        end = Math.min(d.length, end + Math.round(SR * 0.005));
        const pcm = new Int16Array(end);
        for (let i = 0; i < end; i++) {
          const fade = i > end - 220 ? (end - i) / 220 : 1;
          pcm[i] = Math.max(-32767, Math.min(32767, Math.round(d[i] * fade * 32767)));
        }
        let s = ''; const u = new Uint8Array(pcm.buffer);
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        files[inst.id + '_' + sound] = btoa(s);
      }
    }
    const P = GR.buildPreset(GR.PRESETS[0]);
    return { files, project: JSON.stringify(GR.pluginProject(P)) };
  }, projectOnly);
  fs.mkdirSync(out, { recursive: true });
  if (!projectOnly) for (const f of fs.readdirSync(out)) if (f.endsWith('.wav')) fs.unlinkSync(path.join(out, f));
  let total = 0;
  for (const [name, b64] of Object.entries(result.files)) {
    const pcm = Buffer.from(b64, 'base64'), h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(44100, 24);
    h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(path.join(out, name + '.wav'), Buffer.concat([h, pcm])); total += pcm.length + 44;
  }
  fs.writeFileSync(path.join(out, 'default-project.json'), result.project);
  console.log(`${Object.keys(result.files).length} sounds, ${(total / 1048576).toFixed(1)} MB -> ${out}`);
  await b.close(); server.close();
})();
