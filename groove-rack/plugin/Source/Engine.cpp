#include "Engine.h"
#include "BinaryData.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace gr
{
using namespace juce;

//==============================================================================
SampleBank::SampleBank()
{
    formats.registerBasicFormats();
    WavAudioFormat wav;
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
    {
        const String fileName (BinaryData::originalFilenames[i]);
        if (! fileName.endsWithIgnoreCase (".wav"))
            continue;
        int size = 0;
        const char* data = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
        std::unique_ptr<AudioFormatReader> reader (wav.createReaderFor (new MemoryInputStream (data, (size_t) size, false), true));
        if (reader != nullptr)
            kitSounds[fileName.dropLastCharacters (4)] = decode (*reader, 10.0);
    }
}

SamplePtr SampleBank::decode (AudioFormatReader& reader, double maxSeconds)
{
    const int channels = jlimit (1, 2, (int) reader.numChannels);
    const int length = (int) jmin<int64> (reader.lengthInSamples, (int64) (maxSeconds * reader.sampleRate));
    if (length <= 1 || reader.sampleRate <= 0)
        return nullptr;
    auto s = std::make_shared<Sample>();
    s->buffer.setSize (channels, length);
    reader.read (&s->buffer, 0, length, 0, true, channels > 1);
    s->sampleRate = reader.sampleRate;
    return s;
}

SamplePtr SampleBank::kit (const String& key) const
{
    auto it = kitSounds.find (key);
    return it != kitSounds.end() ? it->second : nullptr;
}

SamplePtr SampleBank::file (const File& f)
{
    const auto key = f.getFullPathName();
    if (auto it = files.find (key); it != files.end())
        return it->second;
    if (! f.existsAsFile())
        return nullptr;
    std::unique_ptr<AudioFormatReader> reader (formats.createReaderFor (f));
    if (reader == nullptr)
        return nullptr;
    auto s = decode (*reader, 60.0);
    files[key] = s;
    return s;
}

//==============================================================================
static double num (const var& o, const char* key, double fallback)
{
    const var& x = o[key];
    return (x.isInt() || x.isInt64() || x.isDouble() || x.isBool()) ? (double) x : fallback;
}

PatternPtr parsePattern (const String& json, SampleBank& bank)
{
    auto p = std::make_shared<Pattern>();
    const var v = JSON::parse (json);
    if (! v.isObject())
        return p;

    p->bpm = jlimit (40.0, 240.0, num (v, "bpm", 120.0));
    p->swing = jlimit (0.0, 100.0, num (v, "swing", 0.0));
    p->bars = jlimit (1, 8, (int) num (v, "bars", 4.0));
    p->master = (float) jlimit (0.0, 1.0, num (v, "master", 0.8));

    if (auto* arr = v["tracks"].getArray())
    {
        for (const auto& t : *arr)
        {
            if ((int) p->tracks.size() >= Engine::maxTracks)
                break;
            Track tr;
            tr.id = t["id"].toString();
            tr.name = t["name"].toString();
            tr.res = jlimit (1, 32, (int) num (t, "res", 16.0));
            tr.vol = (float) num (t, "vol", 0.8);
            tr.pan = (float) jlimit (-1.0, 1.0, num (t, "pan", 0.0));
            tr.tone = (float) jlimit (0.0, 1.0, num (t, "tone", 1.0));
            tr.rev = (float) num (t, "rev", 0.0);
            tr.echo = (float) num (t, "echo", 0.0);
            tr.pitch = (float) num (t, "pitch", 0.0);
            tr.decay = (float) jlimit (0.1, 4.0, num (t, "decay", 1.0));
            tr.mute = (bool) t["mute"];
            tr.solo = (bool) t["solo"];

            const var& m = t["_m"];
            tr.pitched = (bool) m["pitched"];
            tr.mono = (bool) m["mono"];
            tr.autoSlide = (bool) m["autoSlide"];
            tr.choke = m["choke"].toString();
            tr.midiCh = jlimit (0, 15, (int) num (m, "ch", 9.0));
            tr.midiNote = jlimit (-1, 127, (int) num (m, "note", 60.0));
            tr.root = (int) num (m, "root", 36.0);

            const String sample = t["sample"].toString();
            if (sample.startsWith ("file:") && File::isAbsolutePath (sample.substring (5)))
                tr.sample = bank.file (File (sample.substring (5)));
            if (tr.sample == nullptr)
                tr.sample = bank.kit (m["kit"].toString());

            if (auto* notes = t["notes"].getArray())
            {
                for (const auto& n : *notes)
                {
                    Note note;
                    note.t = num (n, "t", 0.0);
                    note.len = num (n, "len", (double) TPB / tr.res);
                    note.vel = (float) jlimit (0.0, 1.0, num (n, "vel", 0.9));
                    note.p = (int) num (n, "p", tr.pitched ? 48.0 : 60.0);   // drums: 60 = the sound as it is
                    note.roll = jlimit (1, 8, (int) num (n, "roll", 1.0));
                    note.slide = (bool) n["slide"];
                    note.nudge = jlimit (-2.0, 2.0, num (n, "nudge", 0.0));
                    tr.notes.push_back (note);
                }
            }
            if (tr.solo)
                p->anySolo = true;
            p->tracks.push_back (std::move (tr));
        }
    }

    const int loopT = p->loopTicks();
    p->ticks.assign ((size_t) loopT, {});
    for (int ti = 0; ti < (int) p->tracks.size(); ++ti)
        for (int ni = 0; ni < (int) p->tracks[(size_t) ti].notes.size(); ++ni)
        {
            // a note sits in the tick it actually sounds in, so an early note is scheduled ahead of its grid line
            const Note& no = p->tracks[(size_t) ti].notes[(size_t) ni];
            const int grid = roundToInt (no.t);
            if (grid < 0 || grid >= loopT)
                continue;
            const int tick = (int) std::floor (grid + no.nudge);
            p->ticks[(size_t) (((tick % loopT) + loopT) % loopT)].push_back ({ ti, ni });
        }
    return p;
}

//==============================================================================
Engine::Engine()
{
    voices.resize (maxVoices);
}

void Engine::prepare (double sampleRate, int block)
{
    sr = sampleRate > 0 ? sampleRate : 44100.0;
    maxBlock = jmax (1, block);
    voices.assign (maxVoices, Voice{});
    events.clear();
    events.reserve (8192);
    offs.clear();
    offs.reserve (4096);
    trackBuf.setSize (maxTracks * 2, maxBlock);
    revBuf.setSize (4, maxBlock);
    dlyLine.setSize (2, (int) (sr * 3.0) + 2);
    dlyLine.clear();
    dlyPos = 0;
    dlyLpL = dlyLpR = 0;
    for (auto& f : filters)
        f = Biquad{};
    reverb.setSampleRate (sr);
    Reverb::Parameters rp;
    rp.roomSize = 0.78f; rp.damping = 0.45f; rp.wetLevel = 1.0f; rp.dryLevel = 0.0f; rp.width = 1.0f;
    reverb.setParameters (rp);
    reverb.reset();
    limGain = 1.0f;
    mono = {};
    expectedTick = -1;
    wasPlaying = false;
}

void Engine::setPattern (PatternPtr p)
{
    {
        const SpinLock::ScopedLockType lock (patternLock);
        pending = p;
    }
    // keep recent patterns alive here so the audio thread never frees one
    if (latest != nullptr)
        retired.push_back (latest);
    if (retired.size() > 6)
        retired.erase (retired.begin());
    latest = std::move (p);
}

void Engine::audition (int trackIndex, int pitch, float vel)
{
    auto w = auditionFifo.write (1);
    if (w.blockSize1 > 0)
        auditionQueue[(size_t) w.startIndex1] = { trackIndex, pitch, vel };
}

void Engine::choke (Voice& v)
{
    v.releasing = true;
    v.gate = -1;
    v.relStep = 1.0f / (float) (0.014 * sr);
}

void Engine::schedule (const Pattern& P, double start, double end, double tps, int base)
{
    const int loopT = P.loopTicks();
    for (double k = std::ceil (start - 1e-7); k < end - 1e-7; k += 1.0)
    {
        const auto ki = (int64) std::llround (k);
        const int lt = (int) (((ki % loopT) + loopT) % loopT);
        const double off = base + (k - start) / tps;
        for (const auto& [ti, ni] : P.ticks[(size_t) lt])
        {
            const Track& tr = P.tracks[(size_t) ti];
            const Note& no = tr.notes[(size_t) ni];
            const int grid = roundToInt (no.t);
            const double sounds = grid + no.nudge;
            const double swing = ((grid % 12 == 6) ? P.swing / 100.0 * 3.0 : 0.0) / tps + (sounds - std::floor (sounds)) / tps;
            const double stepT = (double) TPB / tr.res;
            const int roll = jlimit (1, 8, no.roll);
            const double dur = (tr.pitched ? jmax (no.len, 1.0) : stepT) / tps;
            for (int r = 0; r < roll; ++r)
            {
                Event e;
                e.at = (int64) std::llround (off + swing + r * stepT / roll / tps);
                e.track = ti;
                e.p = no.p;
                e.vel = jlimit (0.03f, 1.0f, no.vel * (roll > 1 ? 0.6f + 0.4f * (float) (r + 1) / (float) roll : 1.0f));
                e.dur = roll > 1 ? dur / roll : dur;
                e.slide = no.slide && r == 0;
                events.push_back (e);
            }
        }
    }
}

void Engine::startVoice (const Pattern& P, const Event& e, int fromPitch)
{
    const Track& tr = P.tracks[(size_t) e.track];
    if (tr.sample == nullptr)
        return;
    const Sample& s = *tr.sample;
    const int T = (int) P.tracks.size();

    if (tr.choke.isNotEmpty())
        for (auto& v : voices)
            if (v.active && ! v.releasing && v.track >= 0 && v.track < T && P.tracks[(size_t) v.track].choke == tr.choke)
                choke (v);

    int vi = 0;
    int64 oldest = std::numeric_limits<int64>::max();
    for (int i = 0; i < (int) voices.size(); ++i)
    {
        if (! voices[(size_t) i].active) { vi = i; oldest = -1; break; }
        if (voices[(size_t) i].age < oldest) { oldest = voices[(size_t) i].age; vi = i; }
    }
    Voice& v = voices[(size_t) vi];
    v = Voice{};
    v.active = true;
    v.track = e.track;
    v.pitch = e.p;
    v.s = tr.sample;
    v.vel = e.vel;
    v.age = ++voiceAge;

    const double base = s.sampleRate / sr;
    const double target = base * std::pow (2.0, (tr.pitch + (tr.pitched ? e.p - tr.root : e.p - 60)) / 12.0);
    v.rate = target;
    if (fromPitch >= 0 && tr.pitched)
    {
        const double from = base * std::pow (2.0, (tr.pitch + fromPitch - tr.root) / 12.0);
        const int g = jmax (1, (int) (0.08 * sr));
        v.rate = from;
        v.rateMul = std::pow (target / from, 1.0 / g);
        v.glideLeft = g;
    }
    if (tr.pitched)
    {
        v.gate = jmax<int64> (1, (int64) e.dur);
        v.relStep = 1.0f / (float) (0.06 * jmax (0.3f, tr.decay) * sr);
    }
    else if (tr.decay < 0.999f)
    {
        const double L = s.buffer.getNumSamples() / target;
        v.fadeStart = (int64) (L * tr.decay * 0.6);
        v.fadeMul = (float) std::exp (std::log (0.001) / jmax (32.0, L * tr.decay * 0.4));
    }
    if (tr.pitched && tr.mono)
        mono[(size_t) e.track] = { e.p, clock + e.at + (int64) e.dur, vi };
}

void Engine::fire (const Pattern& P, const Event& e, MidiBuffer& midiOut)
{
    if (e.track < 0 || e.track >= (int) P.tracks.size())
        return;
    const Track& tr = P.tracks[(size_t) e.track];
    if (e.liveOff)
    {
        for (auto& v : voices)
            if (v.active && v.track == e.track && v.pitch == e.p && ! v.releasing)
                v.gate = 0;
        return;
    }
    int from = -1;
    if (tr.pitched && tr.mono)
    {
        auto& m = mono[(size_t) e.track];
        if (m.p >= 0)
        {
            const int64 now = clock + e.at;
            if (e.slide || (tr.autoSlide && m.end > now + 5))
                from = m.p;
            if (m.voice >= 0 && voices[(size_t) m.voice].active && voices[(size_t) m.voice].track == e.track)
                choke (voices[(size_t) m.voice]);
        }
    }
    startVoice (P, e, from);

    if (! e.live)
    {
        const int ch = tr.midiCh + 1;
        const int note = tr.pitched ? jlimit (0, 127, e.p + roundToInt (tr.pitch)) : tr.midiNote;
        if (note >= 0)
        {
            midiOut.addEvent (MidiMessage::noteOn (ch, note, (uint8) jlimit (1, 127, roundToInt (e.vel * 127.0f))), (int) e.at);
            const int64 len = jmax<int64> (1, (int64) (tr.pitched ? e.dur * 0.98 : jmin (e.dur, 0.06 * sr)));
            offs.push_back ({ e.at + len, ch, note });
        }
    }
}

void Engine::renderVoices (int start, int end)
{
    if (end <= start)
        return;
    for (auto& v : voices)
    {
        if (! v.active)
            continue;
        const auto& b = v.s->buffer;
        const int len = b.getNumSamples();
        const float* L = b.getReadPointer (0);
        const float* R = b.getReadPointer (b.getNumChannels() > 1 ? 1 : 0);
        float* oL = trackBuf.getWritePointer (v.track * 2);
        float* oR = trackBuf.getWritePointer (v.track * 2 + 1);
        for (int i = start; i < end; ++i)
        {
            if (v.gate == 0)
                v.releasing = true;
            if (v.gate > 0)
                --v.gate;
            if (v.fadeStart == 0)
            {
                v.env *= v.fadeMul;
                if (v.env < 0.0005f) { v.active = false; break; }
            }
            else if (v.fadeStart > 0)
                --v.fadeStart;
            if (v.releasing)
            {
                v.env -= v.relStep;
                if (v.env <= 0.0f) { v.active = false; break; }
            }
            const int ip = (int) v.pos;
            if (ip >= len - 1) { v.active = false; break; }
            const float fr = (float) (v.pos - ip), g = v.env * v.vel;
            oL[i] += (L[ip] + fr * (L[ip + 1] - L[ip])) * g;
            oR[i] += (R[ip] + fr * (R[ip + 1] - R[ip])) * g;
            v.pos += v.rate;
            if (v.glideLeft > 0) { v.rate *= v.rateMul; --v.glideLeft; }
        }
        if (! v.active)
            v.s.reset();
    }
}

void Engine::mixdown (const Pattern& P, AudioBuffer<float>& out, int n, double bpm)
{
    float* outL = out.getWritePointer (0);
    float* outR = out.getNumChannels() > 1 ? out.getWritePointer (1) : nullptr;
    for (int c = 0; c < 4; ++c)
        revBuf.clear (c, 0, n);
    float* rvL = revBuf.getWritePointer (0); float* rvR = revBuf.getWritePointer (1);
    float* dlL = revBuf.getWritePointer (2); float* dlR = revBuf.getWritePointer (3);

    const int T = (int) P.tracks.size();
    for (int ti = 0; ti < T; ++ti)
    {
        const Track& tr = P.tracks[(size_t) ti];
        float* l = trackBuf.getWritePointer (ti * 2);
        float* r = trackBuf.getWritePointer (ti * 2 + 1);

        Biquad& f = filters[(size_t) ti];
        if (std::abs (f.tone - tr.tone) > 1.0e-6f)
        {
            f.tone = tr.tone;
            if (tr.tone >= 0.995f) { f.b0 = 1; f.b1 = f.b2 = f.a1 = f.a2 = 0; }
            else
            {
                const double fc = jmin (100.0 * std::pow (2.0, tr.tone * 7.7), sr * 0.45);
                const double w0 = MathConstants<double>::twoPi * fc / sr, cw = std::cos (w0), alpha = std::sin (w0) / (2.0 * 0.6), a0 = 1.0 + alpha;
                f.b0 = (float) ((1.0 - cw) / 2.0 / a0); f.b1 = (float) ((1.0 - cw) / a0); f.b2 = f.b0;
                f.a1 = (float) (-2.0 * cw / a0); f.a2 = (float) ((1.0 - alpha) / a0);
            }
        }
        const bool filtered = tr.tone < 0.995f;
        const float gain = (tr.mute || (P.anySolo && ! tr.solo)) ? 0.0f : tr.vol * tr.vol * 1.25f;
        const float th = (tr.pan + 1.0f) * MathConstants<float>::pi * 0.25f;
        const float gl = std::cos (th) * gain, gr = std::sin (th) * gain;
        const float rs = tr.rev * 0.8f, es = tr.echo * 0.7f;
        float pk = 0, sq = 0;
        for (int i = 0; i < n; ++i)
        {
            float x = l[i], y = r[i];
            if (filtered)
            {
                const float xl = f.b0 * x + f.z1[0];
                f.z1[0] = f.b1 * x - f.a1 * xl + f.z2[0]; f.z2[0] = f.b2 * x - f.a2 * xl; x = xl;
                const float xr = f.b0 * y + f.z1[1];
                f.z1[1] = f.b1 * y - f.a1 * xr + f.z2[1]; f.z2[1] = f.b2 * y - f.a2 * xr; y = xr;
            }
            const float a = x * gl, b = y * gr;
            outL[i] += a;
            if (outR != nullptr) outR[i] += b;
            rvL[i] += a * rs; rvR[i] += b * rs;
            dlL[i] += a * es; dlR[i] += b * es;
            const float m = jmax (std::abs (a), std::abs (b));
            pk = jmax (pk, m); sq += m * m;
        }
        if (ti < maxTracks)
        {
            peak[(size_t) ti].store (jmax (peak[(size_t) ti].load(), pk));
            rms[(size_t) ti].store (jmax (rms[(size_t) ti].load(), std::sqrt (sq / (float) jmax (1, n))));
        }
    }

    reverb.processStereo (rvL, rvR, n);
    const int D = jlimit (1, dlyLine.getNumSamples() - 1, (int) (60.0 / bpm * 0.75 * sr));
    const int size = dlyLine.getNumSamples();
    float* dl = dlyLine.getWritePointer (0); float* dr = dlyLine.getWritePointer (1);
    const float lpA = 1.0f - std::exp (-MathConstants<float>::twoPi * 3200.0f / (float) sr);
    const float gain = muted.load() ? 0.0f : P.master * P.master * 1.45f;
    const float relCoef = 1.0f - std::exp (-1.0f / (0.1f * (float) sr));
    for (int i = 0; i < n; ++i)
    {
        const int rd = (dlyPos - D + size) % size;
        dlyLpL += (dl[rd] - dlyLpL) * lpA;
        dlyLpR += (dr[rd] - dlyLpR) * lpA;
        dl[dlyPos] = dlL[i] + dlyLpL * 0.36f;
        dr[dlyPos] = dlR[i] + dlyLpR * 0.36f;
        dlyPos = (dlyPos + 1) % size;

        float L = (outL[i] + rvL[i] * 0.45f + dlyLpL * 0.7f) * gain;
        float R = ((outR != nullptr ? outR[i] : outL[i]) + rvR[i] * 0.45f + dlyLpR * 0.7f) * gain;
        const float x = jmax (std::abs (L), std::abs (R));
        const float target = x > 0.84f ? 0.84f / x : 1.0f;
        if (target < limGain) limGain = target; else limGain += (target - limGain) * relCoef;
        outL[i] = L * limGain;
        if (outR != nullptr) outR[i] = R * limGain;
    }
}

void Engine::process (AudioBuffer<float>& out, MidiBuffer& midi, const Transport& tp)
{
    const int n = out.getNumSamples();
    out.clear();
    {
        const SpinLock::ScopedTryLockType lock (patternLock);
        if (lock.isLocked() && pending != nullptr)
        {
            current = pending;
            pending = nullptr;
        }
    }
    if (current == nullptr || n > maxBlock)
    {
        midi.clear();
        return;
    }
    const Pattern& P = *current;
    const int T = (int) P.tracks.size();
    for (int c = 0; c < T * 2; ++c)
        trackBuf.clear (c, 0, n);

    // MIDI from the DAW plays the tracks: drum notes on any channel, bass tracks on their own channel
    for (const auto meta : midi)
    {
        const auto msg = meta.getMessage();
        if (! msg.isNoteOnOrOff())
            continue;
        const int ch = msg.getChannel() - 1, note = msg.getNoteNumber();
        int target = -1;
        bool pitched = false;
        for (int ti = 0; ti < T; ++ti)
            if (P.tracks[(size_t) ti].pitched && P.tracks[(size_t) ti].midiCh == ch) { target = ti; pitched = true; break; }
        if (target < 0 && msg.isNoteOn())
            for (int ti = 0; ti < T; ++ti)
                if (! P.tracks[(size_t) ti].pitched && P.tracks[(size_t) ti].midiNote == note) { target = ti; break; }
        if (target < 0)
            continue;
        Event e;
        e.at = jlimit (0, n - 1, meta.samplePosition);
        e.track = target; e.p = pitched ? note : 60; e.live = true;
        if (msg.isNoteOn()) { e.vel = jmax (0.03f, msg.getFloatVelocity()); e.dur = pitched ? sr * 30.0 : 0.0; }
        else if (pitched) e.liveOff = true;
        else continue;
        events.push_back (e);
    }
    midi.clear();

    {
        auto rd = auditionFifo.read (auditionFifo.getNumReady());
        rd.forEach ([&] (int i)
        {
            const auto& a = auditionQueue[(size_t) i];
            if (a.track < 0 || a.track >= T) return;
            Event e;
            e.track = a.track; e.p = a.pitch; e.vel = a.vel; e.live = true;
            e.dur = P.tracks[(size_t) a.track].pitched ? 0.32 * sr : 0.0;
            events.push_back (e);
        });
    }

    // transport: follow the DAW when it plays, otherwise the plugin's own play button
    const double bpm = tp.hasBpm && tp.bpm > 0 ? tp.bpm : P.bpm;
    const bool playing = tp.hostPlaying || internalPlay.load();
    const double tps = bpm / 60.0 * (TPB / 4.0) / sr;
    const int loopT = P.loopTicks();
    if (playing)
    {
        double start;
        if (tp.hostPlaying)
        {
            start = tp.ppq * (TPB / 4.0);
            seekBar.store (-1);
        }
        else
        {
            const int sb = seekBar.exchange (-1);
            if (sb >= 0) pendingSeek = sb;
            if (! wasPlaying)
            {
                // starting: begin at the picked bar, or at the top
                internalTick = pendingSeek >= 0 ? pendingSeek * (double) TPB : 0.0;
                pendingSeek = -1;
            }
            start = internalTick;
        }
        const bool continuous = wasPlaying && std::abs (start - expectedTick) < 0.5;
        if (continuous)
            start = expectedTick;
        else
        {
            events.erase (std::remove_if (events.begin(), events.end(), [] (const Event& e) { return ! e.live; }), events.end());
            mono = {};
        }
        const double end = start + n * tps;
        double barLine = std::ceil (start / TPB - 1e-9) * TPB;
        if (! tp.hostPlaying && pendingSeek >= 0 && barLine < end - 1e-9)
        {
            // a bar was picked while playing: finish this bar, then carry on from the picked one on the bar line
            const int split = jlimit (0, n, (int) std::llround ((barLine - start) / tps));
            schedule (P, start, barLine, tps, 0);
            const double to = pendingSeek * (double) TPB;
            pendingSeek = -1;
            schedule (P, to, to + (n - split) * tps, tps, split);
            mono = {};
            expectedTick = to + (n - split) * tps;
            uiTick.store (std::fmod (to, (double) loopT));
        }
        else
        {
            if (tp.hostPlaying) pendingSeek = -1;
            schedule (P, start, end, tps, 0);
            expectedTick = end;
            uiTick.store (std::fmod (std::fmod (start, (double) loopT) + loopT, (double) loopT));
        }
        if (! tp.hostPlaying)
            internalTick = expectedTick;
    }
    else if (wasPlaying)
    {
        events.erase (std::remove_if (events.begin(), events.end(), [] (const Event& e) { return ! e.live; }), events.end());
    }
    wasPlaying = playing;
    uiPlaying.store (playing);
    uiHost.store (tp.hostPlaying);
    uiBpm.store (bpm);
    uiDawTempo.store (tp.hasBpm && tp.bpm > 0);

    // note-offs for the MIDI we send out
    for (auto it = offs.begin(); it != offs.end();)
    {
        if (it->at < n) { midi.addEvent (MidiMessage::noteOff (it->ch, it->note), (int) jmax<int64> (0, it->at)); it = offs.erase (it); }
        else { it->at -= n; ++it; }
    }

    std::stable_sort (events.begin(), events.end(), [] (const Event& a, const Event& b) { return a.at < b.at; });
    int cursor = 0;
    size_t fired = 0;
    for (; fired < events.size() && events[fired].at < n; ++fired)
    {
        const int at = (int) jmax<int64> (0, events[fired].at);
        renderVoices (cursor, at);
        cursor = jmax (cursor, at);
        fire (P, events[fired], midi);
    }
    renderVoices (cursor, n);
    events.erase (events.begin(), events.begin() + (std::ptrdiff_t) fired);
    for (auto& e : events)
        e.at -= n;

    mixdown (P, out, n, bpm);
    clock += n;
}
} // namespace gr
