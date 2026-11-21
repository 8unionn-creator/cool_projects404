#include "PluginProcessor.h"
#include "PluginEditor.h"

SpinRoomProcessor::SpinRoomProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
}

juce::File SpinRoomProcessor::takesFolder()
{
    return juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Spin Room").getChildFile ("Takes");
}

juce::File SpinRoomProcessor::videosFolder()
{
    return juce::File::getSpecialLocation (juce::File::userMoviesDirectory).getChildFile ("Spin Room");
}

void SpinRoomProcessor::prepareToPlay (double sampleRate, int)
{
    recorder.prepare (sampleRate);
}

bool SpinRoomProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void SpinRoomProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    for (auto i = getTotalNumInputChannels(); i < getTotalNumOutputChannels(); ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    bool playing = false;
    double bpm = 0;
    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
        {
            playing = pos->getIsPlaying();
            if (auto b = pos->getBpm()) bpm = *b;
        }

    recorder.process (buffer.getArrayOfReadPointers(), buffer.getNumChannels(), buffer.getNumSamples(), playing, bpm);

    // The standalone app only listens; playing its input back out could cause feedback.
    if (isStandalone())
        buffer.clear();
}

juce::AudioProcessorEditor* SpinRoomProcessor::createEditor()
{
    return new SpinRoomEditor (*this);
}

juce::String SpinRoomProcessor::getWebState() const
{
    const juce::ScopedLock sl (stateLock);
    return webState;
}

void SpinRoomProcessor::setWebState (const juce::String& s)
{
    const juce::ScopedLock sl (stateLock);
    webState = s;
}

void SpinRoomProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::XmlElement xml ("SpinRoom");
    xml.setAttribute ("autoCapture", recorder.getAutoCapture());
    xml.createNewChildElement ("Web")->addTextElement (getWebState());
    copyXmlToBinary (xml, destData);
}

void SpinRoomProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName ("SpinRoom"))
        {
            recorder.setAutoCapture (xml->getBoolAttribute ("autoCapture", true));
            if (auto* web = xml->getChildByName ("Web"))
                setWebState (web->getAllSubText());
        }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new SpinRoomProcessor();
}
