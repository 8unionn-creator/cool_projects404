#include "Core.h"
#include <cmath>
#include <limits>

namespace lf
{
static constexpr double TAU = 6.283185307179586;
static constexpr double PI = 3.141592653589793;

static int pow2 (int n) { int p = 1; while (p < n) p <<= 1; return p; }
static double clamp01 (double x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

bool Params::set (const juce::String& id, double v)
{
    const int i = (int) std::lround (v);
    if (id == "mode") mode = i; else if (id == "phrase") phrase = i; else if (id == "length") length = i;
    else if (id == "build") build = v; else if (id == "curve") curve = v; else if (id == "rise") rise = i != 0;
    else if (id == "pitch") pitch = v; else if (id == "filter") filter = v; else if (id == "wash") wash = v;
    else if (id == "stutter") stutter = v; else if (id == "noise") noise = v; else if (id == "width") width = v;
    else if (id == "verb") verb = i != 0; else if (id == "verbMode") verbMode = i; else if (id == "verbLen") verbLen = i;
    else if (id == "verbSize") verbSize = v; else if (id == "verbTone") verbTone = v; else if (id == "verbMix") verbMix = v;
    else if (id == "drop") drop = i != 0; else if (id == "gap") gap = i; else if (id == "gapStyle") gapStyle = i;
    else if (id == "impact") impact = v; else if (id == "mix") mix = v; else if (id == "output") output = v;
    else if (id == "trem") trem = i != 0; else if (id == "tremRate") tremRate = i; else if (id == "tremDepth") tremDepth = v;
    else if (id == "tremShape") tremShape = i; else if (id == "chorus") chorus = i != 0; else if (id == "chorusRate") chorusRate = v;
    else if (id == "chorusDepth") chorusDepth = v; else if (id == "chorusMix") chorusMix = v;
    else return false;
    return true;
}

double shape (double x, double curve)
{
    x = clamp01 (x);
    return curve >= 0 ? std::pow (x, 1 + 3 * curve) : 1 - std::pow (1 - x, 1 - 3 * curve);
}

Timeline autoTimeline (const Params& P, double beat, double bpb)
{
    Timeline t {};
    t.phraseB = phraseBars[juce::jlimit (0, 3, P.phrase)] * bpb;
    t.buildB = std::min (lengthBars[juce::jlimit (0, 4, P.length)] * bpb, t.phraseB);
    t.gapB = P.drop ? std::min (gapBeatsTable[juce::jlimit (0, 4, P.gap)], t.buildB) : 0;
    if (beat < 0) { t.idx = -1; t.raw = -1; t.toDrop = t.phraseB - beat; return t; }
    t.idx = (long long) std::floor (beat / t.phraseB);
    t.pos = beat - (double) t.idx * t.phraseB;
    const double start = t.phraseB - t.buildB;
    t.raw = t.pos >= start ? (t.pos - start) / t.buildB : -1;
    t.inGap = t.gapB > 0 && t.pos >= t.phraseB - t.gapB;
    t.gapPos = t.pos - (t.phraseB - t.gapB);
    t.toDrop = t.phraseB - t.pos;
    return t;
}

std::array<std::vector<float>, 2> makeReverseIR (double sr, int N, double size, double tone, uint32_t seed)
{
    N = std::max (64, N);
    const double tailDb = -60 + 48 * size;
    const double k = std::log (std::pow (10.0, -tailDb / 20)) / N;
    const double bright = 2000 * std::pow (8.0, tone);
    const int fadeN = std::min (N >> 2, (int) std::lround (sr * 0.005));
    std::array<std::vector<float>, 2> out;
    for (int ch = 0; ch < 2; ++ch)
    {
        Rng r (seed + (uint32_t) ch * 7919u);
        std::vector<float> h ((size_t) N);
        double lp = 0, energy = 0;
        for (int t = 0; t < N; ++t)
        {
            const double fc = std::min (bright * (1 - 0.8 * t / N), sr * 0.45);
            const double a = std::exp (-TAU * fc / sr);
            lp = lp * a + (1 - a) * r.next();
            h[(size_t) t] = (float) (lp * std::exp (-k * t));
        }
        for (int i = 0; i < fadeN; ++i)
            h[(size_t) (N - 1 - i)] = (float) (h[(size_t) (N - 1 - i)] * ((double) i / fadeN));
        for (int t = 0; t < N; ++t)
            energy += (double) h[(size_t) t] * h[(size_t) t];
        const double g = energy > 0 ? 1 / std::sqrt (energy) : 0;
        auto& rev = out[(size_t) ch];
        rev.resize ((size_t) N);
        for (int t = 0; t < N; ++t)
            rev[(size_t) t] = (float) (h[(size_t) (N - 1 - t)] * g);
    }
    return out;
}

void SVF::set (double fc, double q, double sr)
{
    const double g = std::tan (PI * std::min (fc, sr * 0.45) / sr);
    k = 1 / q; a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
}

void SVF::run (double v0)
{
    const double v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    lp = v2; bp = v1; hp = v0 - k * v1 - v2;
}

void Wash::prepare (double sr)
{
    static constexpr int len[] = { 1031, 1327, 1523, 1801, 2063, 2357, 2671, 2999 };
    const double t60 = 4.0;
    for (int i = 0; i < 8; ++i)
    {
        lines[(size_t) i].assign ((size_t) (std::lround (len[i] * sr / 48000) + 1), 0.0f);
        g[(size_t) i] = std::pow (10.0, -3.0 * (double) (lines[(size_t) i].size() - 1) / (t60 * sr));
    }
    pos.fill (0); lp.fill (0); v.fill (0);
    damp = std::exp (-TAU * 6500 / sr);
    oL = oR = 0;
}

void Wash::run (double inL, double inR)
{
    for (size_t i = 0; i < 8; ++i)
    {
        lp[i] = (float) (lines[i][(size_t) pos[i]] * (1 - damp) + lp[i] * damp);
        v[i] = (float) (lp[i] * g[i]);
    }
    for (int h = 1; h < 8; h <<= 1)
        for (int i = 0; i < 8; i += h << 1)
            for (int j = i; j < i + h; ++j)
            {
                const double a = v[(size_t) j], b = v[(size_t) (j + h)];
                v[(size_t) j] = (float) (a + b); v[(size_t) (j + h)] = (float) (a - b);
            }
    const double s = 0.35355339;
    double l = 0, r = 0;
    for (size_t i = 0; i < 8; ++i)
    {
        auto& b = lines[i];
        const int p = pos[i];
        const double out = b[(size_t) p];
        if (i & 1) r += out; else l += out;
        b[(size_t) p] = (float) (v[i] * s + ((i & 1) ? inR : inL) * 0.5);
        pos[i] = p + 1 >= (int) b.size() ? 0 : p + 1;
    }
    oL = l * 0.5; oR = r * 0.5;
}

//==============================================================================
double Core::target (int k) const
{
    switch (k)
    {
        case sBuild: return P.build;   case sCurve: return P.curve;     case sPitch: return P.pitch;
        case sFilter: return P.filter; case sWash: return P.wash;       case sStutter: return P.stutter;
        case sNoise: return P.noise;   case sWidth: return P.width;     case sVerbMix: return P.verbMix;
        case sImpact: return P.impact; case sMix: return P.mix;         case sOutput: return std::pow (10.0, P.output / 20);
        case sTremDepth: return P.tremDepth; case sChorusRate: return P.chorusRate; case sChorusDepth: return P.chorusDepth;
        default: return P.chorusMix;
    }
}

void Core::snapSmoothing() { for (int k = 0; k < numSmoothed; ++k) S[(size_t) k] = target (k); }

void Core::prepare (double sampleRate)
{
    sr = sampleRate;
    smoothA = 1 - std::exp (-1 / (0.02 * sr));
    psN = pow2 ((int) std::ceil (0.2 * sr)); psL.assign ((size_t) psN, 0.0f); psR.assign ((size_t) psN, 0.0f); psW = 0;
    psK = (int) std::lround (0.012 * sr);
    psXF = (int) std::lround (0.008 * sr);
    psD = psK + (double) std::lround (0.035 * sr); psDo = 0; psX = -1; psG = 0; psA = 1 - std::exp (-1 / (0.01 * sr));
    psCmp.assign ((size_t) psK, 0.0);
    hN = pow2 ((int) std::ceil (sr * 3.2)); hL.assign ((size_t) hN, 0.0f); hR.assign ((size_t) hN, 0.0f); hW = 0;
    hpL = hpR = lpL = lpR = nL = nR = SVF();
    wash.prepare (sr);
    chN = pow2 ((int) std::ceil (0.05 * sr)); chL.assign ((size_t) chN, 0.0f); chR.assign ((size_t) chN, 0.0f); chW = 0; chPh = 0; tremSm = 1;
    noise = Rng (0xa11ce);
    gate = 1; gapEnv = 0;
    gateA = 1 - std::exp (-1 / (0.0015 * sr));
    cutA = 1 - std::exp (-1 / (0.003 * sr));
    freeBeat = 0; hasPrevIdx = false; prevBuilding = false; armed = false;
    trigActive = false; trigBeat = 0; pendingLaunch = false; hasPrevBar = false;
    inGap = false; gapT = 0; gapStart = 0; gapLen = 1;
    impT = -1; impPhase = 0; dropT = -1; drops = 0; coefT = 0;
    snapSmoothing();
}

void Core::dropNow()
{
    impT = 0; impPhase = 0; dropT = 0; ++drops;
    inGap = false; armed = false;
}

double Core::readHist (const std::vector<float>& buf, double pos) const
{
    const long long i = (long long) std::floor (pos);
    const double f = pos - (double) i;
    const double a = buf[(size_t) (i & (hN - 1))], b = buf[(size_t) ((i + 1) & (hN - 1))];
    return a + (b - a) * f;
}

double Core::psRead (const std::vector<float>& buf, int pw, double d) const
{
    const double r = pw - d;
    const long long i = (long long) std::floor (r);
    const double f = r - (double) i, a = buf[(size_t) (i & (psN - 1))];
    return a + (buf[(size_t) ((i + 1) & (psN - 1))] - a) * f;
}

// the grain caught up with the input: jump back about J samples, to where the next K samples best match what it plays now
double Core::splice (int pw, double d, double drift)
{
    const long long m = psN - 1, K = psK;
    const long long J = std::llround ((0.035 + 0.02 * drift) * sr), a0 = (long long) std::floor (pw - d);
    for (long long k = 0; k < K; k += 2)
        psCmp[(size_t) k] = (double) psL[(size_t) ((a0 + k) & m)] + (double) psR[(size_t) ((a0 + k) & m)];
    double best = -std::numeric_limits<double>::infinity();
    long long bestOff = 0;
    for (long long off = -K; off <= K; ++off)
    {
        const long long b0 = a0 - J - off;
        double xy = 0, yy = 0;
        for (long long k = 0; k < K; k += 2)
        {
            const double b = (double) psL[(size_t) ((b0 + k) & m)] + (double) psR[(size_t) ((b0 + k) & m)];
            xy += psCmp[(size_t) k] * b; yy += b * b;
        }
        const double sc = xy / std::sqrt (yy + 1e-9);
        if (sc > best) { best = sc; bestOff = off; }
    }
    return d + (double) J + (double) bestOff;
}

void Core::process (const float* inL, const float* inR, float* outL, float* outR, float* sendL, float* sendR, int n, const Transport& tp)
{
    const double A = smoothA;
    const double bpm = std::max (20.0, tp.bpm > 0 ? tp.bpm : 120.0), bpb = tp.bpb > 0 ? tp.bpb : 4.0, bps = bpm / 60 / sr;
    const bool rise = P.rise, dropOn = P.drop;
    const double gapBeats = dropOn ? gapBeatsTable[juce::jlimit (0, 4, P.gap)] : 0;
    const double sliceBeats = 0.25;
    double peakIn = 0, peakOut = 0, lastP = 0, lastRaw = -1, toDrop = -1;

    for (int i = 0; i < n; ++i)
    {
        for (int k = 0; k < numSmoothed; ++k)
            S[(size_t) k] += (target (k) - S[(size_t) k]) * A;
        const double xL = inL[i], xR = inR[i];
        peakIn = std::max (peakIn, std::max (std::abs (xL), std::abs (xR)));

        // ---------- timeline: progress, gap, drop ----------
        const bool playing = tp.playing && tp.ppq + i * bps >= 0;
        const double beat = playing ? tp.ppq + i * bps : freeBeat;
        freeBeat = beat + bps;
        double raw = -1, gapLenBeats = gapBeats;
        bool gapNow = false, drop = false;
        if (P.mode == autoMode)
        {
            if (playing)
            {
                const auto T = autoTimeline (P, beat, bpb);
                raw = T.raw; gapNow = T.inGap; gapLenBeats = T.gapB; toDrop = T.toDrop;
                drop = hasPrevIdx && T.idx == prevIdx + 1 && prevBuilding;
                prevIdx = T.idx; hasPrevIdx = true; prevBuilding = raw >= 0;
            }
            else { hasPrevIdx = false; prevBuilding = false; }
        }
        else if (P.mode == manualMode)
        {
            const double b = S[sBuild];
            raw = b > 0.0005 ? b : -1;
            if (b >= 0.9) armed = true;
            if (armed && b < 0.1) drop = true;
            gapNow = gapBeats > 0 && b >= 0.995;
        }
        else
        {
            const long long barIdx = (long long) std::floor (beat / bpb);
            if (pendingLaunch && (! playing || (hasPrevBar && barIdx > prevBarIdx))) trigger();
            prevBarIdx = barIdx; hasPrevBar = true;
            if (trigActive)
            {
                const double buildB = lengthBars[juce::jlimit (0, 4, P.length)] * bpb;
                gapLenBeats = std::min (gapBeats, buildB);
                if (trigBeat >= buildB) { drop = true; trigActive = false; }
                else
                {
                    raw = trigBeat / buildB; gapNow = gapLenBeats > 0 && trigBeat >= buildB - gapLenBeats;
                    toDrop = buildB - trigBeat; trigBeat += bps;
                }
            }
        }
        if (drop) dropNow();
        const bool building = raw >= 0;
        const double p = building ? shape (raw, S[sCurve]) : 0;
        lastP = p; lastRaw = raw;

        if (gapNow && ! inGap)
        {
            inGap = true; gapT = 0; gapStart = hW;
            gapLen = std::max (1.0, gapLenBeats / bps);
            lpL.reset(); lpR.reset();
        }
        else if (! gapNow && inGap) inGap = false;

        if ((coefT++ & 15) == 0)
        {
            if (rise && S[sFilter] > 0) { const double fc = 20 * std::pow (150.0, S[sFilter] * p), q = 0.7 + 1.5 * S[sFilter] * p; hpL.set (fc, q, sr); hpR.set (fc, q, sr); }
            if (rise && S[sNoise] > 0) { const double fc = 300 * std::pow (40.0, p); nL.set (fc, 1.2, sr); nR.set (fc, 1.2, sr); }
            if (inGap && P.gapStyle == gapFilter)
            {
                const double u = std::min (1.0, gapT / gapLen), fc = 9000 * std::pow (60.0 / 9000, u);
                lpL.set (fc, 0.9, sr); lpR.set (fc, 0.9, sr);
            }
        }

        // ---------- rise ----------
        double sL = xL, sR = xR;
        const int pw = psW; psL[(size_t) pw] = (float) xL; psR[(size_t) pw] = (float) xR; psW = (pw + 1) & (psN - 1);
        const double semis = rise ? S[sPitch] * p : 0;
        const bool psOn = semis > 0.01;
        psG += ((psOn ? 1.0 : 0.0) - psG) * psA;
        if (psOn || psG > 1e-4)
        {
            const double drift = psOn ? std::pow (2.0, semis / 12) - 1 : 0.0;
            psD -= drift; if (psX >= 0) psDo -= drift;
            if (psX < 0 && psD < std::max ((double) psK, psXF * drift + 2)) { psDo = psD; psD = splice (pw, psD, drift); psX = 0; }
            double yL = psRead (psL, pw, psD), yR = psRead (psR, pw, psD);
            if (psX >= 0)
            {
                const double w = (double) psX / psXF;
                yL = psRead (psL, pw, psDo) * (1 - w) + yL * w; yR = psRead (psR, pw, psDo) * (1 - w) + yR * w;
                if (++psX >= psXF) psX = -1;
            }
            sL += (yL - sL) * psG; sR += (yR - sR) * psG;
        }
        else { psD = psK + (double) std::lround (0.035 * sr); psX = -1; }
        if (rise && S[sFilter] > 0) { hpL.run (sL); hpR.run (sR); sL = hpL.hp; sR = hpR.hp; }
        if (rise && S[sStutter] > 0)
        {
            static constexpr double stepsTable[] = { 1, 2, 4, 8 };
            const double steps = stepsTable[std::min (3, (int) std::floor (p * 4))];
            const double f = beat * steps - std::floor (beat * steps);
            gate += ((f < 0.5 ? 1.0 : 0.0) - gate) * gateA;
            const double depth = S[sStutter] * std::min (1.0, p * 1.5);
            const double g = 1 - depth * (1 - gate);
            sL *= g; sR *= g;
        }

        // ---------- pre-drop gap ----------
        const long long hw = hW;
        hL[(size_t) (hw & (hN - 1))] = (float) sL; hR[(size_t) (hw & (hN - 1))] = (float) sR; hW = hw + 1;
        gapEnv += ((inGap ? 1.0 : 0.0) - gapEnv) * cutA;
        if (inGap)
        {
            const double t = gapT, G = gapLen, u = std::min (1.0, t / G);
            if (P.gapStyle == gapTape)
            {
                const double pos = (double) gapStart + (t < G ? t - t * t / (2 * G) : G / 2);
                const double v = std::sqrt (std::max (0.0, 1 - u));
                sL = readHist (hL, pos) * v; sR = readHist (hR, pos) * v;
            }
            else if (P.gapStyle == gapFilter)
            {
                lpL.run (sL); lpR.run (sR); const double v = 1 - 0.5 * u; sL = lpL.lp * v; sR = lpR.lp * v;
            }
            else if (P.gapStyle == gapStutter)
            {
                const double S1 = std::max (32.0, std::min (G, sliceBeats / bps)), ti = std::fmod (t, S1);
                const double fade = std::min ({ 1.0, ti / (0.002 * sr), (S1 - ti) / (0.002 * sr) });
                const double pos = (double) gapStart + ti;
                sL = readHist (hL, pos) * fade; sR = readHist (hR, pos) * fade;
            }
            else { const double v = 1 - gapEnv; sL *= v; sR *= v; }
            gapT += 1;
        }

        // ---------- chorus ----------
        const int cw = chW, cm = chN - 1;
        chL[(size_t) cw] = (float) sL; chR[(size_t) cw] = (float) sR; chW = (cw + 1) & cm;
        if (P.chorus)
        {
            double cp = chPh + S[sChorusRate] / sr; cp -= std::floor (cp); chPh = cp;
            const double base = 0.012 * sr, dep = 0.006 * sr * S[sChorusDepth];
            auto tap = [&] (const std::vector<float>& buf, double ph)
            {
                const double r = cw - (base + dep * std::sin (TAU * ph));
                const long long ix = (long long) std::floor (r);
                const double f = r - (double) ix, a = buf[(size_t) (ix & cm)];
                return a + (buf[(size_t) ((ix + 1) & cm)] - a) * f;
            };
            const double wL = 0.5 * (tap (chL, cp) + tap (chL, cp + 0.5)), wR = 0.5 * (tap (chR, cp + 0.25) + tap (chR, cp + 0.75));
            const double cmix = S[sChorusMix];
            sL = sL * (1 - 0.5 * cmix) + wL * cmix; sR = sR * (1 - 0.5 * cmix) + wR * cmix;
        }

        // ---------- impact on the drop ----------
        double imp = 0, crack = 0;
        if (impT >= 0)
        {
            const double ts = (double) impT / sr;
            const double f = 42 + 80 * std::exp (-ts / 0.03);
            impPhase += f / sr; impPhase -= std::floor (impPhase);
            const double atk = std::min (1.0, (double) impT / (0.001 * sr));
            imp = std::sin (TAU * impPhase) * std::exp (-ts / 0.45) * atk;
            crack = noise.next() * std::exp (-ts / 0.05);
            ++impT;
            if (ts > 2.5) impT = -1;
        }
        const double impAmt = dropOn ? S[sImpact] : 0;
        const double impMono = impAmt * (0.75 * imp + 0.3 * crack);

        // ---------- noise riser ----------
        double nzL = 0, nzR = 0;
        if (rise && S[sNoise] > 0 && building && ! inGap)
        {
            nL.run (noise.next()); nR.run (noise.next());
            const double lv = S[sNoise] * 0.5 * std::pow (p, 1.6);
            nzL = nL.bp * lv; nzR = nR.bp * lv;
        }

        // ---------- wash ----------
        const double wAmt = rise ? S[sWash] * p : 0;
        wash.run (sL * wAmt + nzL * 0.4 + impAmt * crack * 0.5, sR * wAmt + nzR * 0.4 + impAmt * crack * 0.5);
        const double duck = 1 - 0.6 * wAmt * p;
        double oL = sL * duck + wash.oL + nzL + impMono;
        double oR = sR * duck + wash.oR + nzR + impMono;

        // ---------- tremolo, on the beat grid ----------
        if (P.trem)
        {
            const double steps = tremStepsTable[juce::jlimit (0, 5, P.tremRate)], ph = beat * steps - std::floor (beat * steps), d = S[sTremDepth];
            double lL, lR;
            if (P.tremShape == tremSquare) { tremSm += ((ph < 0.5 ? 1.0 : 0.0) - tremSm) * gateA; lL = lR = tremSm; }
            else if (P.tremShape == tremRamp) { tremSm += ((1 - ph) - tremSm) * gateA; lL = lR = tremSm; }
            else if (P.tremShape == tremPan) { lL = 0.5 + 0.5 * std::cos (TAU * ph); lR = 0.5 - 0.5 * std::cos (TAU * ph); }
            else lL = lR = 0.5 + 0.5 * std::cos (TAU * ph);
            oL *= 1 - d * (1 - lL); oR *= 1 - d * (1 - lR);
        }

        // ---------- width ----------
        if (rise && S[sWidth] > 0 && p > 0)
        {
            const double mid = (oL + oR) * 0.5, side = (oL - oR) * 0.5 * (1 + 1.5 * S[sWidth] * p);
            oL = mid + side; oR = mid - side;
        }

        // ---------- mix, output ----------
        const double mx = S[sMix], og = S[sOutput];
        oL = (xL + (oL - xL) * mx) * og; oR = (xR + (oR - xR) * mx) * og;
        outL[i] = (float) oL; outR[i] = (float) oR;
        peakOut = std::max (peakOut, std::max (std::abs ((double) outL[i]), std::abs ((double) outR[i])));

        // ---------- backverb send ----------
        double sg = 0;
        if (P.verb)
        {
            if (P.verbMode == verbAlways) sg = 1;
            else if (P.verbMode == verbBuild) sg = p;
            else if (dropT >= 0)
            {
                const double win = 0.5 / bps, t = (double) dropT;
                sg = t < 0.6 * win ? 1 : t < win ? 0.5 * (1 + std::cos (PI * (t - 0.6 * win) / (0.4 * win))) : 0;
                dropT = t + 1 < win ? dropT + 1 : -1;
            }
            sg *= S[sVerbMix] * 1.5 * mx * og;
        }
        sendL[i] = (float) (xL * sg); sendR[i] = (float) (xR * sg);
    }

    ui.p = lastP; ui.raw = lastRaw; ui.inGap = inGap; ui.toDrop = toDrop; ui.beat = tp.playing ? tp.ppq + n * bps : freeBeat;
    ui.building = lastRaw >= 0; ui.trig = trigActive; ui.pending = pendingLaunch; ui.drops = drops;
    ui.peakIn = (float) std::max (ui.peakIn * 0.85, peakIn); ui.peakOut = (float) std::max (ui.peakOut * 0.85, peakOut);
}

//==============================================================================
Engine::Engine() = default;

int Engine::latencyFor (const Params& p, double bpm) const
{
    return p.verb ? (int) std::lround (verbBeats[juce::jlimit (0, 3, p.verbLen)] * 60.0 / std::max (20.0, bpm) * sr) : 0;
}

void Engine::prepare (double sampleRate, int block)
{
    sr = sampleRate; maxBlock = std::max (1, block);
    core.prepare (sr);
    send.setSize (2, maxBlock); wet.setSize (2, maxBlock);
    dN = pow2 ((int) std::ceil (sr * 6.5) + maxBlock);   // 1 bar at 40 BPM, and a block
    dL.assign ((size_t) dN, 0.0f); dR.assign ((size_t) dN, 0.0f); dW = 0;
    conv.prepare ({ sr, (juce::uint32) maxBlock, 2 });
    conv.reset();
}

void Engine::loadIR (const Params& p, double bpm, bool activateNow)
{
    const int N = latencyFor (p, bpm);
    if (N > 0)
    {
        auto ir = makeReverseIR (sr, N, p.verbSize, p.verbTone);
        juce::AudioBuffer<float> b (2, (int) ir[0].size());
        for (int c = 0; c < 2; ++c)
            b.copyFrom (c, 0, ir[(size_t) c].data(), (int) ir[(size_t) c].size());
        conv.loadImpulseResponse (std::move (b), sr, juce::dsp::Convolution::Stereo::yes,
                                  juce::dsp::Convolution::Trim::no, juce::dsp::Convolution::Normalise::no);
        if (activateNow)
            conv.prepare ({ sr, (juce::uint32) maxBlock, 2 });
        convReady = true;
    }
    irLatency = N;
}

void Engine::process (juce::AudioBuffer<float>& io, const Transport& tp, int start, int num)
{
    const int chans = io.getNumChannels();
    float* L = io.getWritePointer (0, start);
    float* R = chans > 1 ? io.getWritePointer (1, start) : L;
    const int delay = juce::jlimit (0, dN - maxBlock - 1, irLatency.load());

    for (int done = 0; done < num;)
    {
        const int n = std::min (maxBlock, num - done);
        Transport t = tp;
        t.ppq = tp.ppq + done * (std::max (20.0, tp.bpm) / 60.0 / sr);
        core.process (L + done, R + done, wet.getWritePointer (0), wet.getWritePointer (1),
                      send.getWritePointer (0), send.getWritePointer (1), n, t);

        const bool useVerb = core.P.verb && delay > 0 && convReady;
        if (useVerb)
        {
            juce::dsp::AudioBlock<float> blk (send.getArrayOfWritePointers(), 2, (size_t) n);
            conv.process (juce::dsp::ProcessContextReplacing<float> (blk));
        }
        const float* wL = wet.getReadPointer (0); const float* wR = wet.getReadPointer (1);
        const float* vL = send.getReadPointer (0); const float* vR = send.getReadPointer (1);
        for (int i = 0; i < n; ++i)
        {
            dL[(size_t) dW] = wL[i]; dR[(size_t) dW] = wR[i];
            const int r = (dW - delay) & (dN - 1);
            float oL = dL[(size_t) r], oR = dR[(size_t) r];
            if (useVerb) { oL += vL[i]; oR += vR[i]; }
            L[done + i] = oL;
            if (R != L) R[done + i] = oR;
            dW = (dW + 1) & (dN - 1);
        }
        done += n;
    }
}
} // namespace lf
