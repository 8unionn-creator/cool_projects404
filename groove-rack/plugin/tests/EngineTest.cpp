// Renders the default beat through the plugin engine, the way a DAW would call it, and checks the result.
#include <juce_audio_formats/juce_audio_formats.h>
#include "../Source/Engine.h"
#include "BinaryData.h"
#include <set>

using namespace juce;

static int failures = 0;
static void check (bool ok, const String& what) { std::cout << (ok ? "  ok   " : "  FAIL ") << what << "\n"; if (! ok) ++failures; }

static void writeWav (const File& f, const AudioBuffer<float>& b, double rate)
{
    f.deleteFile();
    std::unique_ptr<OutputStream> os (f.createOutputStream());
    WavAudioFormat wav;
    auto w = wav.createWriterFor (os, AudioFormatWriterOptions{}.withSampleRate (rate).withNumChannels (b.getNumChannels()).withBitsPerSample (16));
    if (w) w->writeFromAudioSampleBuffer (b, 0, b.getNumSamples());
}

static String resource (const char* fileName)
{
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
        if (String (fileName) == BinaryData::originalFilenames[i])
        {
            int size = 0;
            const char* d = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
            return String::fromUTF8 (d, size);
        }
    return {};
}

int main (int argc, char** argv)
{
    const double sr = 48000.0; const int block = 512;
    gr::SampleBank bank;
    const String json = resource ("default-project.json");
    check (json.isNotEmpty(), "default project is bundled");
    auto pattern = gr::parsePattern (json, bank);
    check (pattern->tracks.size() == 8, "default beat has 8 tracks (got " + String ((int) pattern->tracks.size()) + ")");
    bool allSamples = true;
    for (auto& t : pattern->tracks) allSamples = allSamples && t.sample != nullptr;
    check (allSamples, "every track found its kit sample");

    gr::Engine engine;
    engine.prepare (sr, block);
    engine.setPattern (pattern);

    // a DAW playing 8 bars at 150 BPM
    const double bpm = 150.0, seconds = 8 * 4 * 60.0 / bpm;
    const int total = (int) (seconds * sr);
    AudioBuffer<float> out (2, total), buf (2, block);
    int noteOns = 0, noteOffs = 0; float peak = 0;
    std::map<int, int> perNote;
    for (int pos = 0; pos < total; pos += block)
    {
        const int n = jmin (block, total - pos);
        AudioBuffer<float> b (buf.getArrayOfWritePointers(), 2, n);
        MidiBuffer midi;
        gr::Engine::Transport tp; tp.hostPlaying = true; tp.hasBpm = true; tp.bpm = bpm; tp.ppq = (double) pos / sr * bpm / 60.0;
        engine.process (b, midi, tp);
        for (const auto m : midi) { auto msg = m.getMessage(); if (msg.isNoteOn()) { ++noteOns; ++perNote[msg.getChannel() * 128 + msg.getNoteNumber()]; } else if (msg.isNoteOff()) ++noteOffs; }
        for (int c = 0; c < 2; ++c) { out.copyFrom (c, pos, b, c, 0, n); peak = jmax (peak, b.getMagnitude (c, 0, n)); }
    }
    // count the pattern's own hits to compare with MIDI out
    int expected = 0;
    for (auto& t : pattern->tracks) for (auto& no : t.notes) if (no.t < pattern->loopTicks()) expected += no.roll;
    check (peak > 0.3f && peak <= 1.0f, "audio is loud and below clipping (peak " + String (peak, 3) + ")");
    check (noteOns == expected, "MIDI out sends every hit (" + String (noteOns) + " of " + String (expected) + ")");
    check (noteOffs >= noteOns - 8, "MIDI out closes its notes (" + String (noteOffs) + " offs)");
    check (perNote.count (10 * 128 + 36) && perNote.count (2 * 128 + 30), "kick on channel 10 note 36 and 808 on channel 2");

    // tempo sync: the DAW at 100 BPM (the project says 150) puts every kick on the DAW's grid
    {
        gr::Engine e2; e2.prepare (sr, block); e2.setPattern (pattern);
        const double dawBpm = 100.0, startPpq = 7.25;   // starts mid-loop, as when you press play in the middle of a song
        std::vector<double> kickBeats;
        for (int pos = 0; pos < (int) (sr * 12); pos += block)
        {
            AudioBuffer<float> b (2, block); MidiBuffer midi;
            gr::Engine::Transport tp; tp.hostPlaying = true; tp.hasBpm = true; tp.bpm = dawBpm;
            tp.ppq = startPpq + (double) pos / sr * dawBpm / 60.0;
            e2.process (b, midi, tp);
            for (const auto m : midi)
                if (m.getMessage().isNoteOn() && m.getMessage().getNoteNumber() == 36)
                    kickBeats.push_back (startPpq + (pos + m.samplePosition) / sr * dawBpm / 60.0);
        }
        // where the default beat's kicks should land, in quarter notes of the DAW's timeline
        std::set<double> want;
        for (auto& t : pattern->tracks) if (t.midiNote == 36) for (auto& no : t.notes) want.insert (no.t / 24.0);
        int onGrid = 0;
        for (double kb : kickBeats)
        {
            const double inLoop = std::fmod (kb, pattern->loopTicks() / 24.0);
            for (double w : want) if (std::abs (inLoop - w) < 1.5 / sr * dawBpm / 60.0) { ++onGrid; break; }
        }
        check (kickBeats.size() > 10 && onGrid == (int) kickBeats.size(),
               "at the DAW's 100 BPM every kick lands on its beat (" + String (onGrid) + " of " + String ((int) kickBeats.size()) + " within a sample)");
        check (std::abs (e2.uiBpm.load() - dawBpm) < 1e-9 && e2.uiDawTempo.load(), "the plugin reports the DAW's tempo to the UI");
    }

    // MIDI in: a note on the kick's note plays it while the DAW is stopped
    {
        MidiBuffer midi; midi.addEvent (MidiMessage::noteOn (1, 36, (uint8) 110), 0);
        AudioBuffer<float> b (2, block); float pk = 0;
        gr::Engine::Transport stopped;
        engine.process (b, midi, stopped);
        for (int i = 0; i < 6; ++i) { pk = jmax (pk, b.getMagnitude (0, block)); MidiBuffer none; engine.process (b, none, stopped); }
        check (pk > 0.1f, "MIDI note 36 from the DAW plays the kick (peak " + String (pk, 3) + ")");
    }

    // a user sample replaces a kit sound
    {
        auto f = File::getSpecialLocation (File::tempDirectory).getChildFile ("gr_test_sample.wav");
        AudioBuffer<float> tone (1, 4800);
        for (int i = 0; i < 4800; ++i) tone.setSample (0, i, 0.5f * std::sin ((float) i * 0.05f));
        writeWav (f, tone, 48000);
        auto v = JSON::parse (json);
        v["tracks"][0].getDynamicObject()->setProperty ("sample", "file:" + f.getFullPathName());
        auto p2 = gr::parsePattern (JSON::toString (v), bank);
        check (p2->tracks[0].sample != nullptr && p2->tracks[0].sample->buffer.getNumSamples() == 4800, "kick uses a WAV file from disk");
    }

    if (argc > 1)
    {
        writeWav (File (argv[1]), out, sr);
        std::cout << "wrote " << argv[1] << "\n";
    }
    std::cout << (failures ? "FAILED\n" : "all passed\n");
    return failures ? 1 : 0;
}
