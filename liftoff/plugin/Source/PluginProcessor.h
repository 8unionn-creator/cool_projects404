#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
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
    juce::String presetKey { "f:0" };             // message thread: "f:3" a factory preset, "u:0" one of yours

    // SAMPLE mode: the track passes through dry, REC captures it, and the rendered transition plays on top
    std::atomic<bool> sampleView { true };
    juce::String uiJson, samplePath;              // message thread only
    void startRecording();
    juce::AudioBuffer<float> stopRecording();     // what was captured
    std::atomic<bool> recording { false };
    std::atomic<int> recPos { 0 };
    std::atomic<float> recLevel { 0 };

    struct Render { juce::AudioBuffer<float> audio; double sampleRate = 48000; juce::String name; juce::int64 endAt = 0; };
    void setRender (std::shared_ptr<Render>);     // message thread
    std::shared_ptr<Render> currentRender() const { return std::atomic_load (&render); }
    void preview (bool on, juce::int64 fromSample);   // play the render
    void audition (std::shared_ptr<Render>);          // play the part of the sample you chose, once
    std::atomic<bool> previewing { false }, auditioning { false };
    std::atomic<juce::int64> previewPos { 0 };

    // IN SONG: the riser plays along with the DAW, its drop on bar cueBar
    std::atomic<bool> cueOn { false }, cueing { false };
    std::atomic<int> cueBar { 17 };
    std::atomic<double> cuePos { 0 };             // seconds into the riser, while it sounds

    juce::AudioFormatManager formats;
    static juce::File dataDir();
    static juce::File userPresetsFile() { return dataDir().getChildFile ("User Presets.json"); }
    static bool writeWav (const juce::File&, const juce::AudioBuffer<float>&, double sampleRate);
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
    juce::AudioBuffer<float> recBuffer;           // 60 s, allocated in prepareToPlay
    std::shared_ptr<Render> render, playBuf;      // the latest render; what is playing (the render or the part)
    std::vector<std::shared_ptr<Render>> retired; // let go of by the audio thread, freed later on the message thread
    std::atomic<double> lastBpm { 120 };
    juce::String irKey;
    // the riser IN SONG plays is kept on disk, so a reopened session plays it before its window is opened
    juce::String cueId, cuePath;
    juce::int64 cueEnd = 0;
    std::shared_ptr<Render> cueSaved;
    double renderAt = 0;
    void keepCueRender();
    void loadCueRender();
    JUCE_DECLARE_WEAK_REFERENCEABLE (LiftoffProcessor)

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiftoffProcessor)
};
