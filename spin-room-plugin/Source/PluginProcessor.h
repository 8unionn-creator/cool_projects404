#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "TakeRecorder.h"

/*  Spin Room as a plugin. Put it on the Master channel: it passes the sound through untouched,
    catches each run of the beat while the DAW plays, and shows Spin Room in its window.
    In the standalone app it listens to the chosen audio input instead.                      */
class SpinRoomProcessor : public juce::AudioProcessor
{
public:
    SpinRoomProcessor();
    ~SpinRoomProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override                          { return true; }

    const juce::String getName() const override              { return JucePlugin_Name; }
    bool acceptsMidi() const override                        { return false; }
    bool producesMidi() const override                       { return false; }
    bool isMidiEffect() const override                       { return false; }
    double getTailLengthSeconds() const override             { return 0.0; }

    int getNumPrograms() override                            { return 1; }
    int getCurrentProgram() override                         { return 0; }
    void setCurrentProgram (int) override                    {}
    const juce::String getProgramName (int) override         { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    TakeRecorder& getRecorder()                              { return recorder; }
    bool isStandalone() const                                { return wrapperType == wrapperType_Standalone; }

    // Spin Room's settings (its JSON), saved with the DAW project
    juce::String getWebState() const;
    void setWebState (const juce::String&);

    static juce::File takesFolder();
    static juce::File videosFolder();

private:
    TakeRecorder recorder { takesFolder() };
    mutable juce::CriticalSection stateLock;
    juce::String webState;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SpinRoomProcessor)
};
