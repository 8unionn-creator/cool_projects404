// Loads the built Liftoff.vst3 the way a DAW does and plays audio through it.
//   LiftoffHostTest path/to/Liftoff.vst3
#include <juce_audio_processors/juce_audio_processors.h>
#include <cstdio>

using namespace juce;

static int failed = 0, passed = 0;
static void check (const char* name, bool ok, const String& detail = {})
{
    if (ok) { ++passed; std::printf ("  ok   %s\n", name); }
    else { ++failed; std::printf ("  FAIL %s %s\n", name, detail.toRawUTF8()); }
}

// a 16-bit stereo WAV
static bool writeWav (const File& f, const AudioBuffer<float>& b, int sr)
{
    MemoryOutputStream o;
    const int n = b.getNumSamples();
    o.write ("RIFF", 4); o.writeInt (36 + n * 4); o.write ("WAVEfmt ", 8); o.writeInt (16); o.writeShort (1); o.writeShort (2);
    o.writeInt (sr); o.writeInt (sr * 4); o.writeShort (4); o.writeShort (16); o.write ("data", 4); o.writeInt (n * 4);
    for (int i = 0; i < n; ++i)
        for (int c = 0; c < 2; ++c)
            o.writeShort ((short) roundToInt (jlimit (-1.0f, 1.0f, b.getSample (c, i)) * 32767.0f));
    return f.replaceWithData (o.getData(), o.getDataSize());
}

// a VST3's saved state, as a DAW keeps it: the processor's own state (XML) inside the host's VST3PluginState
static bool editState (AudioPluginInstance& p, std::function<void (XmlElement&)> edit)
{
    MemoryBlock outer;
    p.getStateInformation (outer);
    auto vst = AudioProcessor::getXmlFromBinary (outer.getData(), (int) outer.getSize());
    auto* comp = vst != nullptr ? vst->getChildByName ("IComponent") : nullptr;
    if (comp == nullptr) return false;
    MemoryBlock inner;
    inner.fromBase64Encoding (comp->getAllSubText());
    auto xml = AudioProcessor::getXmlFromBinary (inner.getData(), (int) inner.getSize());
    if (xml == nullptr) return false;
    edit (*xml);
    MemoryBlock edited, all;
    AudioProcessor::copyXmlToBinary (*xml, edited);
    comp->deleteAllTextElements();
    comp->addTextElement (edited.toBase64Encoding());
    AudioProcessor::copyXmlToBinary (*vst, all);
    p.setStateInformation (all.getData(), (int) all.getSize());
    return true;
}

struct Head : AudioPlayHead
{
    double ppq = 0, bpm = 120;
    Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        p.setBpm (bpm); p.setPpqPosition (ppq); p.setIsPlaying (true);
        p.setTimeSignature (TimeSignature { 4, 4 });
        return p;
    }
};

int main (int argc, char** argv)
{
    ScopedJuceInitialiser_GUI init;
    if (argc < 2) { std::printf ("usage: LiftoffHostTest Liftoff.vst3\n"); return 2; }
    std::printf ("Liftoff plugin in a host\n");

    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> types;
    vst3.findAllTypesForFile (types, File::getCurrentWorkingDirectory().getChildFile (argv[1]).getFullPathName());
    check ("the VST3 is found", types.size() == 1, String (types.size()));
    if (types.isEmpty()) return 1;
    check ("it is an effect named Liftoff", types[0]->name == "Liftoff" && ! types[0]->isInstrument, types[0]->name);

    String err;
    const double sr = 48000; const int block = 480;
    auto plugin = vst3.createInstanceFromDescription (*types[0], sr, block, err);
    check ("it loads", plugin != nullptr, err);
    if (plugin == nullptr) return 1;

    const auto params = plugin->getParameters();
    StringArray names;
    for (auto* p : params) names.add (p->getName (64));
    names.removeString ("Bypass");   // the host's own bypass
    check ("its 28 parameters come from params.js, nothing else", names.size() == 28 && names.contains ("Build") && names.contains ("Backverb mode")
           && names.contains ("Tremolo rate") && names.contains ("Chorus mix") && ! names.contains ("Gap style"),
           String (params.size()) + ": " + names.joinIntoString (", ").substring (0, 300));

    Head head;
    plugin->setPlayHead (&head);
    plugin->setPlayConfigDetails (2, 2, sr, block);
    plugin->prepareToPlay (sr, block);
    check ("a new instance opens in SAMPLE mode, with no latency", plugin->getLatencySamples() == 0, String (plugin->getLatencySamples()));

    // SAMPLE mode: the track passes through untouched (REC and PREVIEW work on top of it)
    AudioBuffer<float> buf (2, block);
    MidiBuffer midi;
    bool finite = true; double maxErr = 0;
    const int blocks = (int) (sr * 4 / block);
    for (int b = 0; b < blocks; ++b)
    {
        for (int i = 0; i < block; ++i)
        {
            const float v = 0.3f * std::sin (6.2831853f * 220.0f * (float) (b * block + i) / (float) sr);
            buf.setSample (0, i, v); buf.setSample (1, i, v);
        }
        head.ppq = (double) b * block / sr * head.bpm / 60.0;
        plugin->processBlock (buf, midi);
        for (int i = 0; i < block; ++i)
        {
            const float v = 0.3f * std::sin (6.2831853f * 220.0f * (float) (b * block + i) / (float) sr);
            finite &= std::isfinite (buf.getSample (0, i));
            maxErr = jmax (maxErr, (double) std::abs (buf.getSample (0, i) - v));
        }
    }
    check ("4 seconds of audio pass through untouched", finite && maxErr < 1e-6, String (maxErr));

    {   // IN SONG, from a saved session: the riser (its drop 2 beats in) plays with the DAW, the drop on bar 3's downbeat (beat 8 = 4 s)
        const int endAt = (int) sr, len = (int) (sr * 1.5);
        AudioBuffer<float> riser (2, len);
        riser.clear();
        riser.setSample (0, 0, 0.5f); riser.setSample (1, 0, 0.5f);
        riser.setSample (0, endAt, 0.9f); riser.setSample (1, endAt, 0.9f);
        const auto wav = File::getSpecialLocation (File::tempDirectory).getChildFile ("liftoff-host-test-riser.wav");
        const bool edited = writeWav (wav, riser, (int) sr) && editState (*plugin, [&] (XmlElement& x)
        {
            x.setAttribute ("cue", 1); x.setAttribute ("cueBar", 3);
            x.setAttribute ("cuePath", wav.getFullPathName()); x.setAttribute ("cueEnd", endAt);
        });
        int64 dropAt = -1, startAt = -1; double other = 0;
        for (int b = 0; b < (int) (sr * 6 / block); ++b)
        {
            buf.clear();
            head.ppq = (double) b * block / sr * head.bpm / 60.0;
            plugin->processBlock (buf, midi);
            for (int i = 0; i < block; ++i)
            {
                const float v = buf.getSample (0, i);
                const int64 at = (int64) b * block + i;
                if (v > 0.8f) dropAt = at; else if (v > 0.4f) startAt = at; else other = jmax (other, (double) std::abs (v));
            }
        }
        check ("IN SONG, from a saved session: the riser plays with the DAW and its drop lands on bar 3",
               edited && dropAt == (int64) (sr * 4) && startAt == (int64) (sr * 3) && other < 1e-4,
               "edited " + String ((int) edited) + ", drop at " + String (dropAt) + ", start at " + String (startAt));
        editState (*plugin, [] (XmlElement& x) { x.setAttribute ("cue", 0); });
        wav.deleteFile();
    }

    MemoryBlock state;
    plugin->getStateInformation (state);
    plugin->setStateInformation (state.getData(), (int) state.getSize());
    check ("its state saves and loads", state.getSize() > 100, String ((int) state.getSize()));

    plugin->releaseResources();
    plugin.reset();
    std::printf ("\n%d passed, %d failed\n", passed, failed);
    return failed ? 1 : 0;
}
