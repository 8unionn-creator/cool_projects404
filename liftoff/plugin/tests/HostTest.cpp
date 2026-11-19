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
    check ("its 24 parameters come from params.js, nothing else", names.size() == 24 && names.contains ("Build") && names.contains ("Backverb mode") && names.contains ("Gap style"),
           String (params.size()) + ": " + names.joinIntoString (", ").substring (0, 300));

    Head head;
    plugin->setPlayHead (&head);
    plugin->setPlayConfigDetails (2, 2, sr, block);
    plugin->prepareToPlay (sr, block);
    check ("it reports the backverb length as latency (1/2 note at 120 BPM)", plugin->getLatencySamples() == 48000, String (plugin->getLatencySamples()));

    AudioBuffer<float> buf (2, block);
    MidiBuffer midi;
    bool finite = true; float peak = 0; double energy = 0;
    const int blocks = (int) (sr * 10 / block);
    for (int b = 0; b < blocks; ++b)
    {
        for (int i = 0; i < block; ++i)
        {
            const float v = 0.3f * std::sin (6.2831853f * 220.0f * (float) (b * block + i) / (float) sr);
            buf.setSample (0, i, v); buf.setSample (1, i, v);
        }
        head.ppq = (double) b * block / sr * head.bpm / 60.0;
        plugin->processBlock (buf, midi);
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < block; ++i)
            {
                const float v = buf.getSample (c, i);
                finite &= std::isfinite (v); peak = jmax (peak, std::abs (v)); energy += (double) v * v;
            }
    }
    check ("10 seconds of audio come out finite and bounded", finite && peak < 4 && energy > 1, String (peak));

    MemoryBlock state;
    plugin->getStateInformation (state);
    plugin->setStateInformation (state.getData(), (int) state.getSize());
    check ("its state saves and loads", state.getSize() > 100, String ((int) state.getSize()));

    plugin->releaseResources();
    plugin.reset();
    std::printf ("\n%d passed, %d failed\n", passed, failed);
    return failed ? 1 : 0;
}
