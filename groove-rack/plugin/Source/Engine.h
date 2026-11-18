// Groove Rack plugin — sampler, sequencer and mixer.
// The web UI edits the project; the engine plays it in sync with the DAW.
#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>
#include <map>
#include <memory>
#include <vector>

namespace gr
{
constexpr int TPB = 96;   // ticks per 4/4 bar, same as the web app

struct Sample
{
    juce::AudioBuffer<float> buffer;
    double sampleRate = 44100.0;
};
using SamplePtr = std::shared_ptr<const Sample>;

struct Note
{
    double t = 0, len = 6;
    float vel = 0.9f;
    int p = 48, roll = 1;
    bool slide = false;
};

struct Track
{
    juce::String id, name, choke;
    int res = 16, midiCh = 9, midiNote = 60, root = 36;
    float vol = 0.8f, pan = 0.0f, tone = 1.0f, rev = 0.0f, echo = 0.0f, pitch = 0.0f, decay = 1.0f;
    bool mute = false, solo = false, pitched = false, mono = false, autoSlide = false;
    SamplePtr sample;
    std::vector<Note> notes;
};

struct Pattern
{
    double bpm = 120.0, swing = 0.0;
    int bars = 4;
    float master = 0.8f;
    bool anySolo = false;
    std::vector<Track> tracks;
    std::vector<std::vector<std::pair<int, int>>> ticks;   // per loop tick: (track, note)
    int loopTicks() const { return bars * TPB; }
};
using PatternPtr = std::shared_ptr<const Pattern>;

//==============================================================================
class SampleBank
{
public:
    SampleBank();
    SamplePtr kit (const juce::String& key) const;
    SamplePtr file (const juce::File& f);              // message thread; cached
    static SamplePtr decode (juce::AudioFormatReader& reader, double maxSeconds);
    juce::AudioFormatManager formats;

private:
    std::map<juce::String, SamplePtr> kitSounds, files;
};

PatternPtr parsePattern (const juce::String& json, SampleBank& bank);

//==============================================================================
class Engine
{
public:
    static constexpr int maxTracks = 64, maxVoices = 160;

    struct Transport
    {
        bool hostPlaying = false, hasBpm = false;
        double ppq = 0.0, bpm = 120.0;
    };

    Engine();
    void prepare (double sampleRate, int maxBlock);
    void setPattern (PatternPtr p);                      // message thread
    PatternPtr latestPattern() const { return latest; }  // message thread
    void process (juce::AudioBuffer<float>& out, juce::MidiBuffer& midi, const Transport& tp);
    void audition (int trackIndex, int pitch, float vel); // message thread

    std::atomic<bool> internalPlay { false }, muted { false };
    std::atomic<int> seekBar { -1 };

    // read by the editor
    std::atomic<double> uiTick { 0.0 }, uiBpm { 0.0 };
    std::atomic<bool> uiPlaying { false }, uiHost { false }, uiDawTempo { false };
    std::array<std::atomic<float>, maxTracks> peak {}, rms {};

private:
    struct Voice
    {
        bool active = false, releasing = false;
        int track = -1, pitch = 0;
        SamplePtr s;
        double pos = 0, rate = 1, rateMul = 1;
        int glideLeft = 0;
        float vel = 1, env = 1, relStep = 0, fadeMul = 1;
        juce::int64 gate = -1, fadeStart = -1, age = 0;
    };
    struct Event
    {
        juce::int64 at = 0;       // samples from the start of the current block
        int track = 0, p = 48;
        float vel = 1;
        double dur = 0;           // samples
        bool slide = false, live = false, liveOff = false;
    };
    struct Off { juce::int64 at; int ch, note; };
    struct Mono { int p = -1; juce::int64 end = 0; int voice = -1; };
    struct Audition { int track, pitch; float vel; };

    void schedule (const Pattern& P, double startTick, double tps, int n);
    void fire (const Pattern& P, const Event& e, juce::MidiBuffer& midi);
    void startVoice (const Pattern& P, const Event& e, int fromPitch);
    void choke (Voice& v);
    void renderVoices (int start, int end);
    void mixdown (const Pattern& P, juce::AudioBuffer<float>& out, int n, double bpm);

    double sr = 44100.0;
    int maxBlock = 512;
    juce::SpinLock patternLock;
    PatternPtr pending, current, latest;
    std::vector<PatternPtr> retired;

    std::vector<Voice> voices;
    std::vector<Event> events;
    std::vector<Off> offs;
    std::array<Mono, maxTracks> mono {};
    juce::AudioBuffer<float> trackBuf, revBuf, dlyLine;
    int dlyPos = 0;
    float dlyLpL = 0, dlyLpR = 0;
    struct Biquad { float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1[2] {}, z2[2] {}; float tone = -1; };
    std::array<Biquad, maxTracks> filters {};
    juce::Reverb reverb;
    float limGain = 1.0f;

    juce::AbstractFifo auditionFifo { 64 };
    std::array<Audition, 64> auditionQueue {};

    double internalTick = 0, expectedTick = -1;
    bool wasPlaying = false;
    juce::int64 clock = 0, voiceAge = 0;
};
} // namespace gr
