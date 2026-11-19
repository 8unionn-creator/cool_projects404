#pragma once

#include <juce_dsp/juce_dsp.h>
#include <array>
#include <atomic>
#include <vector>

// The Liftoff DSP: a sample-for-sample port of ../../dsp.js (keep the two in step; tests/parity.js compares them).
namespace lf
{
static constexpr double phraseBars[] = { 4, 8, 16, 32 };
static constexpr double lengthBars[] = { 0.5, 1, 2, 4, 8 };
static constexpr double verbBeats[] = { 0.5, 1, 2, 4 };
static constexpr double gapBeatsTable[] = { 0, 0.25, 0.5, 1, 2 };
enum Mode { autoMode = 0, manualMode = 1, triggerMode = 2 };
enum VerbMode { verbDrop = 0, verbBuild = 1, verbAlways = 2 };
enum GapStyle { gapCut = 0, gapTape = 1, gapFilter = 2, gapStutter = 3 };
static constexpr double tremStepsTable[] = { 1, 2, 4, 8, 3, 6 };
enum TremShape { tremSine = 0, tremSquare = 1, tremRamp = 2, tremPan = 3 };

struct Params
{
    int mode = 0, phrase = 2, length = 3;
    double build = 0, curve = 0.35;
    bool rise = true;
    double pitch = 7, filter = 0.6, wash = 0.5, stutter = 0.3, noise = 0.35, width = 0.5;
    bool verb = true;
    int verbMode = 0, verbLen = 2;
    double verbSize = 0.5, verbTone = 0.6, verbMix = 0.6;
    bool drop = false;
    int gap = 3, gapStyle = 0;
    double impact = 0.4;
    bool trem = true;
    int tremRate = 1, tremShape = 0;
    double tremDepth = 0.35;
    bool chorus = true;
    double chorusRate = 0.8, chorusDepth = 0.5, chorusMix = 0.4;
    double mix = 1, output = 0;

    bool set (const juce::String& id, double v);   // by the ids in params.js
};

struct Transport
{
    bool playing = false;
    double ppq = 0, bpm = 120, bpb = 4;
};

struct Timeline { long long idx; double pos, raw; bool inGap; double gapPos, toDrop, phraseB, buildB, gapB; };
Timeline autoTimeline (const Params&, double beat, double bpb);
double shape (double x, double curve);

class Rng
{
public:
    explicit Rng (uint32_t seed) : s (seed ? seed : 1u) {}
    double next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (double) s / 4294967296.0 * 2.0 - 1.0; }
private:
    uint32_t s;
};

// the backverb's impulse response, reversed: it swells from its tail up to its peak at the last sample
std::array<std::vector<float>, 2> makeReverseIR (double sr, int N, double size, double tone, uint32_t seed = 0x5eed);

struct SVF
{
    double ic1 = 0, ic2 = 0, a1 = 1, a2 = 0, a3 = 0, k = 1.4, lp = 0, bp = 0, hp = 0;
    void set (double fc, double q, double sr);
    void run (double v0);
    void reset() { ic1 = ic2 = 0; }
};

class Wash
{
public:
    void prepare (double sr);
    void run (double inL, double inR);
    double oL = 0, oR = 0;
private:
    std::array<std::vector<float>, 8> lines;
    std::array<int, 8> pos {};
    std::array<float, 8> lp {}, v {};
    std::array<double, 8> g {};
    double damp = 0;
};

// one sample at a time: the build, rise, gap, impact, wash, noise, width and mix, plus the backverb send
class Core
{
public:
    struct UI { double p = 0, raw = -1, toDrop = -1, beat = 0; bool inGap = false, building = false, trig = false, pending = false; int drops = 0; float peakIn = 0, peakOut = 0; };

    void prepare (double sampleRate);
    void setParams (const Params& p) { P = p; }
    void snapSmoothing();
    void launch() { pendingLaunch = true; }
    void trigger() { trigActive = true; trigBeat = 0; pendingLaunch = false; }
    void process (const float* inL, const float* inR, float* outL, float* outR, float* sendL, float* sendR, int n, const Transport&);

    Params P;
    UI ui;

private:
    static constexpr int numSmoothed = 16;
    enum { sBuild, sCurve, sPitch, sFilter, sWash, sStutter, sNoise, sWidth, sVerbMix, sImpact, sMix, sOutput,
           sTremDepth, sChorusRate, sChorusDepth, sChorusMix };
    double target (int k) const;
    void dropNow();
    double readHist (const std::vector<float>& buf, double pos) const;

    double sr = 48000, smoothA = 0, gateA = 0, cutA = 0;
    std::array<double, numSmoothed> S {};
    int W = 2400, psN = 4096, psW = 0, hN = 1 << 18;
    std::vector<float> psL, psR, hL, hR, chL, chR;
    int chN = 2048, chW = 0;
    double chPh = 0, tremSm = 1;
    long long hW = 0;
    double phase = 0, gate = 1, gapEnv = 0;
    SVF hpL, hpR, lpL, lpR, nL, nR;
    Wash wash;
    Rng noise { 0xa11ce };
    double freeBeat = 0;
    long long prevIdx = 0; bool hasPrevIdx = false, prevBuilding = false;
    bool armed = false, trigActive = false, pendingLaunch = false;
    double trigBeat = 0;
    long long prevBarIdx = 0; bool hasPrevBar = false;
    bool inGap = false; double gapT = 0, gapLen = 1; long long gapStart = 0;
    long long impT = -1; double impPhase = 0; long long dropT = -1;
    int drops = 0;
    unsigned coefT = 0;
};

// The whole effect: the core, then the dry/processed signal delayed by the backverb length L
// plus the send convolved with the reversed reverb. L is the plugin's latency.
class Engine
{
public:
    Engine();
    void prepare (double sampleRate, int maxBlock);
    void process (juce::AudioBuffer<float>&, const Transport&, int start, int num);

    // message thread: the latency the current settings need at this tempo, and building the IR for it
    int latencyFor (const Params&, double bpm) const;
    void loadIR (const Params&, double bpm, bool activateNow = false);
    std::atomic<int> irLatency { 0 };   // the length of the loaded IR = the delay applied
    double sampleRate() const { return sr; }

    Core core;

private:
    double sr = 48000;
    int maxBlock = 512;
    juce::dsp::Convolution conv { juce::dsp::Convolution::NonUniform { 1024 } };
    juce::AudioBuffer<float> send, wet;
    std::vector<float> dL, dR;
    int dN = 1, dW = 0;
    std::atomic<bool> convReady { false };
};
} // namespace lf
