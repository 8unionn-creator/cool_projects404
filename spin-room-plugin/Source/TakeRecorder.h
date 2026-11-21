#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

/*  Catches what plays through the plugin and saves each run as a WAV "take".

    The audio thread only copies samples into a lock-free FIFO and posts start/stop events
    stamped with a sample position. A background thread drains the FIFO to disk, skips the
    silence before the music starts, trims the silence after it ends, and reports the take.

    A take starts when the host starts playing (auto mode) or when record() is called,
    and ends when the host stops, when stop() is called, or after maxSeconds.            */
class TakeRecorder : private juce::Thread
{
public:
    struct Take
    {
        juce::String id, name;
        juce::File file;
        double seconds = 0, bpm = 0, sampleRate = 0;
        juce::Time time;
        juce::var toVar() const;
    };

    explicit TakeRecorder (juce::File takesFolder);
    ~TakeRecorder() override;

    void prepare (double sampleRate);

    // Audio thread. hostPlaying and bpm come from the host's play head (false / 0 if unknown).
    void process (const float* const* channels, int numChannels, int numSamples, bool hostPlaying, double bpm) noexcept;

    // Message thread.
    void setAutoCapture (bool shouldCatchOnPlay) noexcept   { autoCapture = shouldCatchOnPlay; }
    bool getAutoCapture() const noexcept                     { return autoCapture; }
    void record() noexcept                                   { manualStartRequest = true; }
    void stop() noexcept                                     { manualStopRequest = true; }
    bool isRecording() const noexcept                        { return recording; }
    double getRecordedSeconds() const noexcept               { return sampleRate > 0 ? (double) recordedSamples.load() / sampleRate : 0.0; }
    bool isHostPlaying() const noexcept                      { return lastHostPlaying; }
    double getHostBpm() const noexcept                       { return lastBpm; }
    juce::Array<Take> getTakes() const;
    juce::File getFolder() const                             { return folder; }
    std::optional<Take> findTake (const juce::String& id) const;

    // Called on the message thread when a take has been saved.
    std::function<void (const Take&)> onTakeReady;

    static constexpr double maxSeconds = 20 * 60;
    static constexpr double minSeconds = 1.5;
    static constexpr float silence = 1.0e-4f;   // about -80 dB

    // Waits until everything posted so far has been written (used by tests).
    void flushForTesting (int timeoutMs = 5000);

private:
    struct Event { int type = 0; juce::uint64 at = 0; double bpm = 0; };
    enum { startEvent = 1, stopEvent = 2 };

    void run() override;
    void postEvent (int type, double bpm) noexcept;
    void openTake (double bpm);
    void closeTake();
    void writeFrames (const float* interleaved, int frames);
    void loadIndex();
    void saveIndex() const;

    juce::File folder;
    double sampleRate = 44100;

    // audio thread -> writer thread
    static constexpr int channels = 2;
    juce::AbstractFifo audioFifo { 1 << 20 };          // frames
    std::vector<float> audioData;                       // interleaved, channels per frame
    juce::AbstractFifo eventFifo { 64 };
    std::array<Event, 64> events;
    std::atomic<juce::uint64> pushed { 0 }, drained { 0 };
    std::atomic<bool> recording { false }, autoCapture { true };
    std::atomic<bool> manualStartRequest { false }, manualStopRequest { false };
    std::atomic<bool> lastHostPlaying { false };
    std::atomic<double> lastBpm { 0 };
    std::atomic<juce::uint64> recordedSamples { 0 };
    bool wasHostPlaying = false;

    // writer thread only
    std::unique_ptr<juce::AudioFormatWriter> writer;
    juce::File tempFile;
    double takeBpm = 0;
    juce::uint64 framesWritten = 0, lastLoudFrame = 0;
    bool heardSound = false;
    std::vector<float> scratch;

    std::shared_ptr<bool> alive = std::make_shared<bool> (true); // read on the message thread only

    mutable juce::CriticalSection takesLock;
    juce::Array<Take> takes;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TakeRecorder)
};
