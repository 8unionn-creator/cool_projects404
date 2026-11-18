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

GrooveRackProcessor::GrooveRackProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", AudioChannelSet::stereo(), true))
{
    int size = 0;
    if (const char* data = findResource ("default-project.json", size))
        setProjectJSON (String::fromUTF8 (data, size));
}

void GrooveRackProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    engine.prepare (sampleRate, samplesPerBlock);
    engine.setPattern (engine.latestPattern());
}

bool GrooveRackProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto out = layouts.getMainOutputChannelSet();
    return out == AudioChannelSet::stereo() || out == AudioChannelSet::mono();
}

void GrooveRackProcessor::processBlock (AudioBuffer<float>& buffer, MidiBuffer& midi)
{
    ScopedNoDenormals noDenormals;
    gr::Engine::Transport tp;
    if (auto* ph = getPlayHead())
    {
        if (auto pos = ph->getPosition())
        {
            if (auto ppq = pos->getPpqPosition())
            {
                tp.ppq = *ppq;
                tp.hostPlaying = pos->getIsPlaying();
            }
            if (auto bpm = pos->getBpm())
            {
                tp.bpm = *bpm;
                tp.hasBpm = true;
            }
        }
    }
    engine.process (buffer, midi, tp);
}

void GrooveRackProcessor::setProjectJSON (const String& json)
{
    projectJSON = json;
    engine.setPattern (gr::parsePattern (json, bank));
}

String GrooveRackProcessor::getProjectJSON() const { return projectJSON; }

int GrooveRackProcessor::trackIndex (const String& id) const
{
    if (auto p = engine.latestPattern())
        for (int i = 0; i < (int) p->tracks.size(); ++i)
            if (p->tracks[(size_t) i].id == id)
                return i;
    return -1;
}

void GrooveRackProcessor::getStateInformation (MemoryBlock& destData)
{
    ValueTree state ("GrooveRack");
    state.setProperty ("project", projectJSON, nullptr);
    state.setProperty ("version", JucePlugin_VersionString, nullptr);
    MemoryOutputStream out (destData, false);
    state.writeToStream (out);
}

void GrooveRackProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto state = ValueTree::readFromData (data, (size_t) sizeInBytes);
    if (state.isValid() && state.hasProperty ("project"))
    {
        setProjectJSON (state["project"].toString());
        if (auto* ed = dynamic_cast<GrooveRackEditor*> (getActiveEditor()))
            ed->reloadPage();
    }
}

AudioProcessorEditor* GrooveRackProcessor::createEditor() { return new GrooveRackEditor (*this); }

AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new GrooveRackProcessor(); }
