#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "Core.h"

// a file bundled into the plugin (the web UI), looked up by its file name
const char* findResource (const juce::String& fileName, int& size);

class LiftoffProcessor : public juce::AudioProcessor, private juce::Timer
{
public:
    LiftoffProcessor();
    ~LiftoffProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Liftoff"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 6.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    static juce::var parseList (const juce::String& marker);   // LIFTOFF_PARAMS / LIFTOFF_PRESETS from params.js

    juce::AudioProcessorValueTreeState apvts;
    juce::StringArray ids;
    lf::Engine engine;

    // shared with the editor
    std::atomic<bool> launchRequest { false };
    std::atomic<int> preset { 0 };
    struct UIState
    {
        std::atomic<double> p { 0 }, raw { -1 }, toDrop { -1 }, beat { 0 }, bpm { 120 }, bpb { 4 };
        std::atomic<bool> inGap { false }, trig { false }, pending { false }, hostPlaying { false };
        std::atomic<int> drops { 0 };
        std::atomic<float> peakIn { 0 }, peakOut { 0 };
    } ui;

private:
    lf::Params readParams() const;
    void timerCallback() override;

    std::vector<std::atomic<float>*> raw;
    std::atomic<double> lastBpm { 120 };
    juce::String irKey;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiftoffProcessor)
};
