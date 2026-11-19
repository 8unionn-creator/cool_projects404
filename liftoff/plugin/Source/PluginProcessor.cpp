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
    formats.registerBasicFormats();
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
    setLatencySamples (sampleView ? 0 : engine.irLatency.load());
    irKey = {};
    recBuffer.setSize (2, (int) (sampleRate * 60.0));
    recPos = 0; recording = false;
}

// the reversed reverb is as long as the backverb (at the DAW's tempo), and that length is the plugin's latency:
// rebuild it off the audio thread when the length, size, tone or tempo change
void LiftoffProcessor::timerCallback()
{
    retired.reset();   // a render the audio thread has let go of
    // SAMPLE mode adds no latency; LIVE mode is late by the backverb length
    const int wantLatency = sampleView ? 0 : engine.irLatency.load();
    if (getLatencySamples() != wantLatency)
        setLatencySamples (wantLatency);
    const auto p = readParams();
    const double bpm = lastBpm.load();
    const int want = engine.latencyFor (p, bpm);
    const String key = String (want) + "|" + String (p.verbSize, 3) + "|" + String (p.verbTone, 3);
    if (key == irKey)
        return;
    irKey = key;
    engine.loadIR (p, bpm);
    if (! sampleView && getLatencySamples() != engine.irLatency.load())
        setLatencySamples (engine.irLatency.load());
}

File LiftoffProcessor::dataDir()
{
    auto d = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Liftoff");
    d.createDirectory();
    return d;
}

void LiftoffProcessor::startRecording()
{
    recPos = 0;
    recLevel = 0;
    recording = true;
}

AudioBuffer<float> LiftoffProcessor::stopRecording()
{
    recording = false;
    const int n = jmin (recPos.load(), recBuffer.getNumSamples());
    AudioBuffer<float> out (2, jmax (0, n));
    for (int c = 0; c < 2 && n > 0; ++c)
        out.copyFrom (c, 0, recBuffer, c, 0, n);
    return out;
}

void LiftoffProcessor::setRender (std::shared_ptr<Render> r)
{
    retired = std::atomic_load (&render);
    std::atomic_store (&render, std::move (r));
}

void LiftoffProcessor::preview (bool on, int64 fromSample)
{
    previewPos = jmax ((int64) 0, fromSample);
    previewing = on && currentRender() != nullptr;
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
    ui.bpm = tp.bpm; ui.bpb = tp.bpb; ui.hostPlaying = hostPlaying;

    if (sampleView)
    {
        // SAMPLE mode: the track passes through; REC captures it; the transition plays on top
        const int n = buffer.getNumSamples(), chans = buffer.getNumChannels();
        float peakIn = 0.0f;
        for (int c = 0; c < chans; ++c)
            peakIn = jmax (peakIn, buffer.getMagnitude (c, 0, n));
        if (recording)
        {
            const int at = recPos.load(), room = recBuffer.getNumSamples() - at, k = jmin (n, room);
            for (int c = 0; c < 2 && k > 0; ++c)
                recBuffer.copyFrom (c, at, buffer, jmin (c, chans - 1), 0, k);
            recPos = at + jmax (0, k);
            recLevel = jmax (recLevel.load() * 0.9f, peakIn);
            if (room <= n) recording = false;   // full: 60 s
        }
        if (previewing)
            if (auto r = currentRender())
            {
                const int64 pos = previewPos.load(), len = r->audio.getNumSamples();
                const int k = (int) jlimit ((int64) 0, (int64) n, len - pos);
                for (int c = 0; c < chans && k > 0; ++c)
                    buffer.addFrom (c, 0, r->audio, jmin (c, r->audio.getNumChannels() - 1), (int) pos, k);
                previewPos = pos + n;
                if (pos + n >= len) previewing = false;
            }
        float peakOut = 0.0f;
        for (int c = 0; c < chans; ++c)
            peakOut = jmax (peakOut, buffer.getMagnitude (c, 0, n));
        ui.peakIn = jmax (ui.peakIn.load(), peakIn); ui.peakOut = jmax (ui.peakOut.load(), peakOut);
        midi.clear();
        return;
    }

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
    state.setProperty ("ui", uiJson, nullptr);
    state.setProperty ("sample", samplePath, nullptr);
    state.setProperty ("sampleView", sampleView.load(), nullptr);
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
            uiJson = state.getProperty ("ui", "").toString();
            samplePath = state.getProperty ("sample", "").toString();
            sampleView = (bool) state.getProperty ("sampleView", true);
            apvts.replaceState (state);
        }
}

AudioProcessorEditor* LiftoffProcessor::createEditor() { return new LiftoffEditor (*this); }

AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new LiftoffProcessor(); }
