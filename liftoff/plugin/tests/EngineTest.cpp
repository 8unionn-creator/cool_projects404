// Headless checks of the Liftoff engine (the C++ the plugin runs).
//   LiftoffEngineTest               run the checks
//   LiftoffEngineTest --dump f.raw  also write the core's output for the parity scenarios (tests/parity.js reads it)
#include "../Source/Core.h"
#include <cstdio>
#include <cmath>
#include <functional>

using namespace lf;

static int failed = 0, passed = 0;
static void check (const char* name, bool ok, const juce::String& detail = {})
{
    if (ok) { ++passed; std::printf ("  ok   %s\n", name); }
    else { ++failed; std::printf ("  FAIL %s %s\n", name, detail.toRawUTF8()); }
}
static double db (double x) { return 20 * std::log10 (std::max (1e-12, x)); }
static double rms (const std::vector<float>& a, size_t s, size_t e)
{
    double t = 0; e = std::min (e, a.size());
    for (size_t i = s; i < e; ++i) t += (double) a[i] * a[i];
    return std::sqrt (t / (double) std::max<size_t> (1, e - s));
}

static constexpr double SR = 48000;

struct Run { std::vector<float> L, R; std::vector<int> drops; int latency = 0; };

// plays an input through the engine the way a DAW does: blocks, a running transport, the reported latency
static Run run (Params p, double seconds, std::function<float (int)> input, int block = 512, double bpm = 120,
                std::function<void (Engine&, int)> onBlock = {})
{
    Engine e;
    e.prepare (SR, block);
    e.core.setParams (p); e.core.snapSmoothing();
    e.loadIR (p, bpm, true);
    Run r; r.latency = e.irLatency.load();
    const int N = (int) std::lround (seconds * SR);
    r.L.resize ((size_t) N); r.R.resize ((size_t) N);
    juce::AudioBuffer<float> buf (2, block);
    int drops = 0;
    for (int i = 0; i < N; i += block)
    {
        const int n = std::min (block, N - i);
        for (int j = 0; j < n; ++j) { const float v = input (i + j); buf.setSample (0, j, v); buf.setSample (1, j, v); }
        if (onBlock) onBlock (e, i);
        Transport t; t.playing = true; t.bpm = bpm; t.bpb = 4; t.ppq = i * bpm / 60.0 / SR;
        e.process (buf, t, 0, n);
        for (int j = 0; j < n; ++j) { r.L[(size_t) (i + j)] = buf.getSample (0, j); r.R[(size_t) (i + j)] = buf.getSample (1, j); }
        if (e.core.ui.drops != drops) { r.drops.push_back (i); drops = e.core.ui.drops; }
    }
    return r;
}
static int beat (double b) { return (int) std::lround (b * 60.0 / 120.0 * SR); }

// the scenarios tests/parity.js replays through dsp.js
static void dump (const char* path)
{
    std::FILE* f = std::fopen (path, "wb");
    if (f == nullptr) { std::printf ("cannot write %s\n", path); ++failed; return; }
    const double bpm = 128, spb = 60 / bpm * SR;
    const int block = 256, N = (int) (9 * SR);
    for (int sc = 0; sc < 4; ++sc)
    {
        Params P; P.phrase = 0; P.length = 2;
        if (sc == 1) { P.gapStyle = 1; P.verbMode = 1; P.stutter = 1; P.pitch = 12; }
        if (sc == 2) { P.gapStyle = 2; P.verbMode = 2; P.curve = -0.5; P.width = 1; }
        if (sc == 3) { P.gapStyle = 3; P.gap = 4; P.impact = 1; P.noise = 1; P.output = -6; P.mix = 0.7; }
        Core c; c.prepare (SR); c.setParams (P); c.snapSmoothing();
        Rng rng (1234);
        std::vector<float> inL ((size_t) block), inR ((size_t) block), o[4];
        for (auto& v : o) v.resize ((size_t) block);
        std::vector<float> inter ((size_t) block * 4);
        for (int i = 0; i < N; i += block)
        {
            for (int j = 0; j < block; ++j)
            {
                const int k = i + j;
                const double r = rng.next();
                const double click = (k % (int) std::lround (spb)) == 0 ? 0.5 : 0.0;
                inL[(size_t) j] = (float) (0.3 * std::sin (6.283185307179586 * 220 * k / SR) + 0.05 * r + click);
                inR[(size_t) j] = (float) (0.3 * std::sin (6.283185307179586 * 330 * k / SR) - 0.05 * r);
            }
            Transport t; t.playing = true; t.bpm = bpm; t.bpb = 4; t.ppq = i * bpm / 60 / SR;
            c.process (inL.data(), inR.data(), o[0].data(), o[1].data(), o[2].data(), o[3].data(), block, t);
            for (int j = 0; j < block; ++j)
                for (int q = 0; q < 4; ++q) inter[(size_t) (j * 4 + q)] = o[q][(size_t) j];
            std::fwrite (inter.data(), sizeof (float), inter.size(), f);
        }
    }
    std::fclose (f);
    std::printf ("  wrote %s\n", path);
}

int main (int argc, char** argv)
{
    std::printf ("Liftoff engine\n");
    auto sine = [] (double f) { return [f] (int i) { return (float) (0.5 * std::sin (6.283185307179586 * f * i / SR)); }; };

    {   // with every module off the plugin is a wire, with no latency
        Params p; p.rise = false; p.verb = false; p.drop = false;
        auto r = run (p, 1, sine (330));
        double err = 0;
        for (size_t i = 0; i < r.L.size(); ++i) err = std::max (err, (double) std::abs (r.L[i] - sine (330) ((int) i)));
        check ("everything off: audio passes untouched, no latency", err < 1e-6 && r.latency == 0, juce::String (err));
    }

    {   // the reverse swell made from the drop's first hit ends exactly on that hit
        Params p; p.mode = autoMode; p.phrase = 0; p.length = 1; p.rise = false; p.drop = false;
        p.verb = true; p.verbMode = verbDrop; p.verbLen = 2; p.verbMix = 1;
        const int hit = beat (16);
        auto r = run (p, 10, [hit] (int i) { return i == hit ? 0.8f : 0.0f; });
        const int L = r.latency;
        check ("latency is the backverb length (1/2 note at 120 BPM)", L == beat (2), juce::String (L));
        size_t peak = 0;
        for (size_t i = 0; i < r.L.size(); ++i) if (std::abs (r.L[i]) > std::abs (r.L[peak])) peak = i;
        check ("the hit comes out exactly one latency later", (int) peak == hit + L, juce::String ((int) peak) + " vs " + juce::String (hit + L));
        const double before = rms (r.L, 0, (size_t) hit - 1);
        const double early = rms (r.L, (size_t) hit, (size_t) (hit + L / 8)), late = rms (r.L, (size_t) (hit + L - L / 8), (size_t) (hit + L));
        check ("silence before the swell", db (before) < -120, juce::String (db (before)));
        check ("the swell rises into the hit", db (late) - db (early) > 20, juce::String (db (early)) + " -> " + juce::String (db (late)));
        const double after = rms (r.L, (size_t) (hit + L + 1), (size_t) (hit + L + 4000));
        check ("nothing left after the hit", db (after) < -90, juce::String (db (after)));
    }

    {   // the host's block size makes no difference
        Params p; p.phrase = 0; p.length = 2;
        auto a = run (p, 9, sine (220), 512), b = run (p, 9, sine (220), 333);
        double err = 0;
        for (size_t i = 0; i < a.L.size(); ++i) err = std::max (err, (double) std::abs (a.L[i] - b.L[i]));
        check ("same sound at any block size", err < 1e-4, juce::String (err));
        bool finite = true; float peak = 0;
        for (auto v : a.L) { finite &= std::isfinite (v); peak = std::max (peak, std::abs (v)); }
        check ("full effect stays finite and bounded", finite && peak < 4, juce::String (peak));
        check ("AUTO drops on bar 5 (4 bar phrase)", a.drops.size() == 1 && std::abs (a.drops[0] - beat (16)) < 512, juce::String (a.drops.empty() ? -1 : a.drops[0]));
    }

    {   // a MIDI note (Trigger mode) starts a build that drops BUILD LENGTH later
        Params p; p.mode = triggerMode; p.length = 1; p.verb = false;
        const int at = 3 * 512;
        auto r = run (p, 4, sine (220), 512, 120, [at] (Engine& e, int i) { if (i == at) e.core.trigger(); });
        check ("Trigger: drops one bar after the note", r.drops.size() == 1 && std::abs (r.drops[0] - (at + beat (4))) <= 512,
               juce::String (r.drops.empty() ? -1 : r.drops[0]));
    }

    {   // tempo changes the latency
        Engine e; e.prepare (SR, 512);
        Params p; p.verbLen = 1;
        check ("latency follows the tempo", e.latencyFor (p, 120) == beat (1) && e.latencyFor (p, 60) == beat (2), juce::String (e.latencyFor (p, 120)));
        p.verb = false;
        check ("no backverb, no latency", e.latencyFor (p, 120) == 0);
    }

    for (int i = 1; i + 1 < argc; ++i)
        if (juce::String (argv[i]) == "--dump")
            dump (argv[i + 1]);

    std::printf ("\n%d passed, %d failed\n", passed, failed);
    return failed ? 1 : 0;
}
