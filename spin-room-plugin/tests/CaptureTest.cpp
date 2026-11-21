// Plays a fake DAW transport through TakeRecorder and checks the takes it saves.
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>
#include "../Source/TakeRecorder.h"

namespace
{
    int failures = 0;
    void expect (bool ok, const juce::String& what)
    {
        std::cout << (ok ? "  ok    " : "  FAIL  ") << what << std::endl;
        if (! ok) ++failures;
    }

    // Feeds `seconds` of audio in 512-frame blocks: silence for `leadSilence`, then a sine, then silence.
    void feed (TakeRecorder& r, double sr, double seconds, bool playing, double bpm, double leadSilence = 0, double trailSilence = 0)
    {
        const int block = 512;
        std::vector<float> l (block), rr (block);
        const float* chans[2] = { l.data(), rr.data() };
        const auto total = (juce::int64) (seconds * sr);
        static juce::int64 phase = 0;
        for (juce::int64 done = 0; done < total; done += block)
        {
            const int n = (int) juce::jmin<juce::int64> (block, total - done);
            for (int i = 0; i < n; ++i)
            {
                const double t = (double) (done + i) / sr;
                const bool sound = t >= leadSilence && t < seconds - trailSilence;
                const float v = sound ? 0.4f * (float) std::sin (juce::MathConstants<double>::twoPi * 220.0 * (double) (phase++) / sr) : 0.0f;
                l[(size_t) i] = v; rr[(size_t) i] = v;
            }
            r.process (chans, 2, n, playing, bpm);
        }
    }
}

int main()
{
    juce::ScopedJuceInitialiser_GUI init;
    const double sr = 48000;
    auto folder = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("spinroom-capture-test-" + juce::Uuid().toString());
    folder.deleteRecursively();

    {
        TakeRecorder r (folder);
        r.prepare (sr);

        std::cout << "1. auto: press play, 1 s of silence, 6 s of beat, 2 s of silence, stop" << std::endl;
        feed (r, sr, 0.5, false, 140);                    // transport stopped: nothing caught
        feed (r, sr, 9.0, true, 140, 1.0, 2.0);           // transport playing
        expect (r.isRecording(), "recording while the transport plays");
        feed (r, sr, 0.2, false, 140);                    // transport stops
        r.flushForTesting();
        auto takes = r.getTakes();
        expect (takes.size() == 1, "one take saved");
        if (takes.size() == 1)
        {
            const auto& t = takes[0];
            expect (std::abs (t.seconds - 6.4) < 0.15, "silence trimmed: length " + juce::String (t.seconds, 2) + " s (expected about 6.4)");
            expect (std::abs (t.bpm - 140) < 0.01, "BPM from the DAW: " + juce::String (t.bpm));
            expect (t.file.existsAsFile(), "file written: " + t.file.getFileName());
            juce::WavAudioFormat wav;
            std::unique_ptr<juce::AudioFormatReader> reader (wav.createReaderFor (t.file.createInputStream().release(), true));
            expect (reader != nullptr && reader->numChannels == 2 && reader->bitsPerSample == 24 && std::abs (reader->sampleRate - sr) < 1, "24-bit stereo WAV at the session rate");
            if (reader != nullptr)
            {
                juce::AudioBuffer<float> b (2, 4800);
                reader->read (&b, 0, 4800, 0, true, true);
                expect (b.getMagnitude (0, 0, 4800) > 0.3f, "starts right on the sound");
            }
        }

        std::cout << "2. too short: play 0.8 s and stop" << std::endl;
        feed (r, sr, 0.8, true, 140);
        feed (r, sr, 0.1, false, 140);
        r.flushForTesting();
        expect (r.getTakes().size() == 1, "a run under 1.5 s is not kept");

        std::cout << "3. silence only: play 3 s of silence" << std::endl;
        feed (r, sr, 3.0, true, 140, 3.0, 0);
        feed (r, sr, 0.1, false, 140);
        r.flushForTesting();
        expect (r.getTakes().size() == 1, "a silent run is not kept");

        std::cout << "4. auto off, manual record and stop (standalone)" << std::endl;
        r.setAutoCapture (false);
        feed (r, sr, 1.0, true, 0);
        expect (! r.isRecording(), "auto off: playing does not start a take");
        r.record();
        feed (r, sr, 4.0, false, 0);
        expect (r.isRecording(), "record() starts a take");
        r.stop();
        feed (r, sr, 0.1, false, 0);
        r.flushForTesting();
        takes = r.getTakes();
        expect (takes.size() == 2, "second take saved");
        if (takes.size() == 2)
            expect (std::abs (takes[0].seconds - 4.0) < 0.2 && takes[0].bpm < 0.01, "manual take: " + juce::String (takes[0].seconds, 2) + " s, no BPM");

        std::cout << "5. two runs back to back" << std::endl;
        r.setAutoCapture (true);
        feed (r, sr, 3.0, true, 92); feed (r, sr, 0.05, false, 92);
        feed (r, sr, 3.0, true, 92); feed (r, sr, 0.05, false, 92);
        r.flushForTesting();
        expect (r.getTakes().size() == 4, "both runs saved as separate takes");
        expect (r.findTake (r.getTakes()[0].id).has_value(), "takes can be found by id");
    }

    std::cout << "6. the list survives a restart" << std::endl;
    {
        TakeRecorder again (folder);
        expect (again.getTakes().size() == 4, "4 takes listed after reopening");
        expect (! folder.findChildFiles (juce::File::findFiles, false, ".recording-*").size(), "no temp files left behind");
    }

    folder.deleteRecursively();
    std::cout << (failures == 0 ? "ALL PASSED" : juce::String (failures) + " FAILED") << std::endl;
    return failures == 0 ? 0 : 1;
}
