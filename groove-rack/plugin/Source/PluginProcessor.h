#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "Engine.h"

// a file bundled into the plugin (web UI, kit, default project), looked up by its file name
const char* findResource (const juce::String& fileName, int& size);

class GrooveRackProcessor : public juce::AudioProcessor
{
public:
    GrooveRackProcessor();

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Groove Rack"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // called from the editor's web view (message thread)
    void setProjectJSON (const juce::String& json);
    juce::String getProjectJSON() const;
    int trackIndex (const juce::String& id) const;

    gr::SampleBank bank;
    gr::Engine engine;
    juce::MemoryBlock midiFile;   // the loop as a .mid file, sent by the UI for drag-and-drop

private:
    juce::String projectJSON;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GrooveRackProcessor)
};
