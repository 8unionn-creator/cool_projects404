#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"

using namespace juce;

const char* findResource (const String& fileName, int& size)
{
    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
        if (fileName == BinaryData::originalFilenames[i])
            return BinaryData::getNamedResource (BinaryData::namedResourceList[i], size);
    size = 0;
    return nullptr;
}

var LiftoffProcessor::parseList (const String& marker)
{
    int size = 0;
    const char* data = findResource ("params.js", size);
    if (data == nullptr)
        return {};
    const String js = String::fromUTF8 (data, size);
    const auto from = js.indexOf ("/*" + marker + "*/");
    const auto to = js.indexOf (from, "/*END*/");
    if (from < 0 || to < 0)
        return {};
    return JSON::parse (js.substring (from + marker.length() + 4, to));
}

// the parameters, made from the same list the web page uses
static AudioProcessorValueTreeState::ParameterLayout makeLayout()
{
    AudioProcessorValueTreeState::ParameterLayout layout;
    const auto list = LiftoffProcessor::parseList ("PARAMS");
    jassert (list.isArray() && list.size() > 0);
    if (auto* arr = list.getArray())
    {
        for (const auto& p : *arr)
        {
            const String id = p["id"], name = p["name"], type = p["type"];
            const ParameterID pid { id, 1 };
            if (type == "choice")
            {
                StringArray choices;
                if (auto* c = p["choices"].getArray())
                    for (const auto& s : *c) choices.add (s.toString());
                layout.add (std::make_unique<AudioParameterChoice> (pid, name, choices, (int) p["def"]));
            }
            else if (type == "bool")
                layout.add (std::make_unique<AudioParameterBool> (pid, name, (int) p["def"] != 0));
            else
            {
                const String unit = p["unit"];
                const float mn = (float) (double) p["min"], mx = (float) (double) p["max"];
                auto attrs = AudioParameterFloatAttributes().withLabel (unit == "%" ? String() : unit);
                if (unit == "%")
                    attrs = attrs.withStringFromValueFunction ([] (float v, int) { return String (roundToInt (v * 100)) + "%"; });
                layout.add (std::make_unique<AudioParameterFloat> (pid, name, NormalisableRange<float> (mn, mx), (float) (double) p["def"], attrs));
            }
        }
    }
    return layout;
}

LiftoffProcessor::LiftoffProcessor()
    : AudioProcessor (BusesProperties().withInput ("Input", AudioChannelSet::stereo(), true)
                                       .withOutput ("Output", AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "Liftoff", makeLayout())
{
    for (auto* p : getParameters())
        if (auto* wp = dynamic_cast<RangedAudioParameter*> (p))
        {
            ids.add (wp->getParameterID());
            raw.push_back (apvts.getRawParameterValue (wp->getParameterID()));
        }
    startTimerHz (10);
}

LiftoffProcessor::~LiftoffProcessor() { stopTimer(); }

lf::Params LiftoffProcessor::readParams() const
{
    lf::Params p;
    for (int i = 0; i < ids.size(); ++i)
        p.set (ids[i], raw[(size_t) i]->load());
    return p;
}

void LiftoffProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    engine.prepare (sampleRate, samplesPerBlock);
    const auto p = readParams();
    engine.core.setParams (p);
    engine.core.snapSmoothing();
    engine.loadIR (p, lastBpm.load(), true);
    setLatencySamples (engine.irLatency.load());
    irKey = {};
}

// the reversed reverb is as long as the backverb (at the DAW's tempo), and that length is the plugin's latency:
// rebuild it off the audio thread when the length, size, tone or tempo change
void LiftoffProcessor::timerCallback()
{
    const auto p = readParams();
    const double bpm = lastBpm.load();
    const int want = engine.latencyFor (p, bpm);
    const String key = String (want) + "|" + String (p.verbSize, 3) + "|" + String (p.verbTone, 3);
    if (key == irKey)
        return;
    irKey = key;
    engine.loadIR (p, bpm);
    if (getLatencySamples() != engine.irLatency.load())
        setLatencySamples (engine.irLatency.load());
}

bool LiftoffProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto in = layouts.getMainInputChannelSet(), out = layouts.getMainOutputChannelSet();
    return in == out && (out == AudioChannelSet::stereo() || out == AudioChannelSet::mono());
}

void LiftoffProcessor::processBlock (AudioBuffer<float>& buffer, MidiBuffer& midi)
{
    ScopedNoDenormals noDenormals;
    for (int c = getTotalNumInputChannels(); c < getTotalNumOutputChannels(); ++c)
        buffer.clear (c, 0, buffer.getNumSamples());

    lf::Transport tp;
    bool hostPlaying = false;
    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
        {
            if (auto bpm = pos->getBpm()) tp.bpm = *bpm;
            if (auto sig = pos->getTimeSignature()) tp.bpb = sig->numerator * 4.0 / jmax (1, sig->denominator);
            if (auto ppq = pos->getPpqPosition()) { tp.ppq = *ppq; tp.playing = pos->getIsPlaying(); }
            hostPlaying = pos->getIsPlaying();
        }
    tp.bpm = jlimit (20.0, 400.0, tp.bpm);
    lastBpm = tp.bpm;

    const auto p = readParams();
    engine.core.setParams (p);
    if (launchRequest.exchange (false))
        engine.core.launch();

    // a MIDI note starts a build right where it is (Trigger mode)
    const double bps = tp.bpm / 60.0 / getSampleRate();
    int pos = 0;
    const int total = buffer.getNumSamples();
    for (const auto meta : midi)
    {
        const auto msg = meta.getMessage();
        if (! msg.isNoteOn() || p.mode != lf::triggerMode)
            continue;
        const int at = jlimit (pos, total, meta.samplePosition);
        if (at > pos)
        {
            lf::Transport t = tp; t.ppq = tp.ppq + pos * bps;
            engine.process (buffer, t, pos, at - pos);
        }
        engine.core.trigger();
        pos = at;
    }
    if (pos < total)
    {
        lf::Transport t = tp; t.ppq = tp.ppq + pos * bps;
        engine.process (buffer, t, pos, total - pos);
    }
    midi.clear();

    const auto& u = engine.core.ui;
    ui.p = u.p; ui.raw = u.raw; ui.toDrop = u.toDrop; ui.beat = u.beat; ui.bpm = tp.bpm; ui.bpb = tp.bpb;
    ui.inGap = u.inGap; ui.trig = u.trig; ui.pending = u.pending; ui.hostPlaying = hostPlaying; ui.drops = u.drops;
    ui.peakIn = jmax (ui.peakIn.load(), u.peakIn); ui.peakOut = jmax (ui.peakOut.load(), u.peakOut);
}

void LiftoffProcessor::getStateInformation (MemoryBlock& destData)
{
    auto state = apvts.copyState();
    state.setProperty ("preset", preset.load(), nullptr);
    state.setProperty ("version", JucePlugin_VersionString, nullptr);
    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, destData);
}

void LiftoffProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
        {
            auto state = ValueTree::fromXml (*xml);
            preset = (int) state.getProperty ("preset", 0);
            apvts.replaceState (state);
        }
}

AudioProcessorEditor* LiftoffProcessor::createEditor() { return new LiftoffEditor (*this); }

AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new LiftoffProcessor(); }
