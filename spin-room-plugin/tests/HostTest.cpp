// Loads the built Spin Room.vst3 the way a DAW does: the sound passes through untouched, a run of the
// beat while the transport plays is saved as a take with the DAW's tempo, and the session state round-trips.
//   SpinRoomHostTest "path/to/Spin Room.vst3"
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
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
    bool playing = true;
    double bpm = 128, seconds = 0;
    Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        p.setIsPlaying (playing);
        p.setBpm (bpm);
        p.setTimeInSeconds (seconds);
        p.setTimeSignature (TimeSignature { 4, 4 });
        return p;
    }
};

// the processor's own state (XML) inside the VST3 host's state
static std::unique_ptr<XmlElement> innerState (AudioPluginInstance& p, std::unique_ptr<XmlElement>* outerOut = nullptr)
{
    MemoryBlock outer;
    p.getStateInformation (outer);
    auto vst = AudioProcessor::getXmlFromBinary (outer.getData(), (int) outer.getSize());
    auto* comp = vst != nullptr ? vst->getChildByName ("IComponent") : nullptr;
    if (comp == nullptr) return {};
    MemoryBlock inner;
    inner.fromBase64Encoding (comp->getAllSubText());
    auto xml = AudioProcessor::getXmlFromBinary (inner.getData(), (int) inner.getSize());
    if (outerOut != nullptr) *outerOut = std::move (vst);
    return xml;
}

int main (int argc, char** argv)
{
    ScopedJuceInitialiser_GUI init;
    if (argc < 2) { std::printf ("usage: SpinRoomHostTest \"Spin Room.vst3\"\n"); return 2; }
    std::printf ("Spin Room plugin in a host\n");

    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> types;
    vst3.findAllTypesForFile (types, File::getCurrentWorkingDirectory().getChildFile (argv[1]).getFullPathName());
    check ("the VST3 is found", types.size() == 1, String (types.size()));
    if (types.isEmpty()) return 1;
    check ("it is an effect named Spin Room", types[0]->name == "Spin Room" && ! types[0]->isInstrument, types[0]->name);

    String err;
    const double sr = 48000;
    const int block = 512;
    auto plugin = vst3.createInstanceFromDescription (*types[0], sr, block, err);
    check ("it loads", plugin != nullptr, err);
    if (plugin == nullptr) return 1;

    auto takes = File::getSpecialLocation (File::userMusicDirectory).getChildFile ("Spin Room").getChildFile ("Takes");
    const auto before = takes.findChildFiles (File::findFiles, false, "*.wav");

    Head head;
    plugin->setPlayHead (&head);
    plugin->setPlayConfigDetails (2, 2, sr, block);
    plugin->prepareToPlay (sr, block);
    check ("no latency", plugin->getLatencySamples() == 0, String (plugin->getLatencySamples()));

    // the DAW plays 4 seconds of a beat
    AudioBuffer<float> buf (2, block);
    MidiBuffer midi;
    double maxErr = 0;
    bool finite = true;
    const int blocks = (int) (sr * 4 / block);
    auto tone = [&] (int b, int i) { return 0.3f * std::sin (6.2831853f * 220.0f * (float) (b * block + i) / (float) sr); };
    for (int b = 0; b < blocks; ++b)
    {
        for (int i = 0; i < block; ++i) { buf.setSample (0, i, tone (b, i)); buf.setSample (1, i, tone (b, i)); }
        head.seconds = (double) b * block / sr;
        plugin->processBlock (buf, midi);
        for (int i = 0; i < block; ++i)
        {
            finite &= std::isfinite (buf.getSample (0, i));
            maxErr = jmax (maxErr, (double) std::abs (buf.getSample (0, i) - tone (b, i)));
        }
    }
    check ("4 seconds of audio pass through untouched", finite && maxErr < 1e-6, String (maxErr));

    // the DAW stops
    head.playing = false;
    buf.clear();
    for (int b = 0; b < 10; ++b) plugin->processBlock (buf, midi);

    File newTake;
    for (int tries = 0; tries < 100 && newTake == File(); ++tries)
    {
        Thread::sleep (50);
        for (auto& f : takes.findChildFiles (File::findFiles, false, "*.wav"))
            if (! before.contains (f) && ! f.getFileName().startsWith ("."))
                newTake = f;
    }
    check ("stopping the DAW saves the run as a take", newTake.existsAsFile(), takes.getFullPathName());
    if (newTake.existsAsFile())
    {
        check ("the take is named with the DAW's tempo", newTake.getFileName().contains ("128 BPM"), newTake.getFileName());
        WavAudioFormat wav;
        std::unique_ptr<AudioFormatReader> reader (wav.createReaderFor (newTake.createInputStream().release(), true));
        const double secs = reader != nullptr ? (double) reader->lengthInSamples / reader->sampleRate : 0;
        check ("the take is the 4 seconds that played", std::abs (secs - 4.0) < 0.15, String (secs, 3));
        reader.reset();
        newTake.deleteFile();
    }

    // the session keeps "catch on play" and Spin Room's settings
    std::unique_ptr<XmlElement> outer;
    auto xml = innerState (*plugin, &outer);
    check ("the state is Spin Room's", xml != nullptr && xml->hasTagName ("SpinRoom"));
    if (xml != nullptr && outer != nullptr)
    {
        xml->setAttribute ("autoCapture", false);
        if (auto* web = xml->getChildByName ("Web")) web->deleteAllTextElements(), web->addTextElement (R"({"state":{"producer":"Yeriel"}})");
        MemoryBlock edited, all;
        AudioProcessor::copyXmlToBinary (*xml, edited);
        auto* comp = outer->getChildByName ("IComponent");
        comp->deleteAllTextElements();
        comp->addTextElement (edited.toBase64Encoding());
        AudioProcessor::copyXmlToBinary (*outer, all);
        plugin->setStateInformation (all.getData(), (int) all.getSize());
        auto again = innerState (*plugin);
        check ("a saved session reopens with its settings", again != nullptr && ! again->getBoolAttribute ("autoCapture", true)
                   && again->getChildByName ("Web") != nullptr && again->getChildByName ("Web")->getAllSubText().contains ("Yeriel"));
    }

    // with "catch on play" off, playing doesn't make a take
    const auto count = takes.findChildFiles (File::findFiles, false, "*.wav").size();
    head.playing = true;
    for (int b = 0; b < blocks / 2; ++b) { for (int i = 0; i < block; ++i) { buf.setSample (0, i, tone (b, i)); buf.setSample (1, i, tone (b, i)); } plugin->processBlock (buf, midi); }
    head.playing = false;
    for (int b = 0; b < 10; ++b) plugin->processBlock (buf, midi);
    Thread::sleep (600);
    check ("with catching off, playing saves nothing", takes.findChildFiles (File::findFiles, false, "*.wav").size() == count);

    plugin->releaseResources();
    plugin.reset();
    std::printf ("%d passed, %d failed\n", passed, failed);
    return failed == 0 ? 0 : 1;
}
