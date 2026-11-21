#include "TakeRecorder.h"

juce::var TakeRecorder::Take::toVar() const
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("id", id);
    o->setProperty ("name", name);
    o->setProperty ("file", file.getFileName());
    o->setProperty ("path", file.getFullPathName());
    o->setProperty ("seconds", seconds);
    o->setProperty ("bpm", bpm);
    o->setProperty ("sampleRate", sampleRate);
    o->setProperty ("time", (juce::int64) time.toMilliseconds());
    return juce::var (o);
}

TakeRecorder::TakeRecorder (juce::File takesFolder)
    : juce::Thread ("Spin Room take writer"), folder (std::move (takesFolder))
{
    audioData.resize ((size_t) audioFifo.getTotalSize() * channels);
    folder.createDirectory();
    loadIndex();
    startThread (juce::Thread::Priority::normal);
}

TakeRecorder::~TakeRecorder()
{
    *alive = false;
    signalThreadShouldExit();
    notify();
    stopThread (5000);
}

void TakeRecorder::prepare (double newSampleRate)
{
    if (newSampleRate > 0)
        sampleRate = newSampleRate;
}

void TakeRecorder::postEvent (int type, double bpm) noexcept
{
    int s1, z1, s2, z2;
    eventFifo.prepareToWrite (1, s1, z1, s2, z2);
    if (z1 > 0)
    {
        events[(size_t) s1] = { type, pushed.load(), bpm };
        eventFifo.finishedWrite (1);
    }
}

void TakeRecorder::process (const float* const* ch, int numCh, int n, bool hostPlaying, double bpm) noexcept
{
    lastHostPlaying = hostPlaying;
    if (bpm > 0) lastBpm = bpm;

    if (manualStopRequest.exchange (false) && recording)
    {
        recording = false;
        postEvent (stopEvent, 0);
    }
    if (manualStartRequest.exchange (false) && ! recording)
    {
        recording = true;
        recordedSamples = 0;
        postEvent (startEvent, bpm);
    }
    if (autoCapture)
    {
        if (hostPlaying && ! wasHostPlaying && ! recording)
        {
            recording = true;
            recordedSamples = 0;
            postEvent (startEvent, bpm);
        }
        else if (! hostPlaying && wasHostPlaying && recording)
        {
            recording = false;
            postEvent (stopEvent, 0);
        }
    }
    wasHostPlaying = hostPlaying;

    if (! recording || numCh <= 0 || n <= 0 || ch == nullptr)
        return;

    int s1, z1, s2, z2;
    audioFifo.prepareToWrite (n, s1, z1, s2, z2);
    auto copy = [&] (int dest, int srcOffset, int count)
    {
        for (int c = 0; c < channels; ++c)
        {
            const float* in = ch[juce::jmin (c, numCh - 1)];
            float* out = audioData.data() + (size_t) dest * channels + (size_t) c;
            for (int i = 0; i < count; ++i)
                out[(size_t) i * channels] = in != nullptr ? in[srcOffset + i] : 0.0f;
        }
    };
    if (z1 > 0) copy (s1, 0, z1);
    if (z2 > 0) copy (s2, z1, z2);
    audioFifo.finishedWrite (z1 + z2);
    pushed += (juce::uint64) (z1 + z2);
    recordedSamples += (juce::uint64) n;

    if ((double) recordedSamples.load() > maxSeconds * sampleRate)
    {
        recording = false;
        postEvent (stopEvent, 0);
    }
}

void TakeRecorder::run()
{
    while (! threadShouldExit())
    {
        bool didSomething = false;

        int e1, ez1, e2, ez2;
        eventFifo.prepareToRead (1, e1, ez1, e2, ez2);
        const Event* ev = ez1 > 0 ? &events[(size_t) e1] : nullptr;

        auto limit = pushed.load();
        if (ev != nullptr) limit = juce::jmin (limit, ev->at);

        while (drained.load() < limit)
        {
            const int want = (int) juce::jmin<juce::uint64> (limit - drained.load(), 8192);
            int a1, b1, a2, b2;
            audioFifo.prepareToRead (want, a1, b1, a2, b2);
            if (b1 + b2 == 0) break;
            if (writer != nullptr)
            {
                writeFrames (audioData.data() + (size_t) a1 * channels, b1);
                if (b2 > 0) writeFrames (audioData.data() + (size_t) a2 * channels, b2);
            }
            audioFifo.finishedRead (b1 + b2);
            drained += (juce::uint64) (b1 + b2);
            didSomething = true;
        }

        if (ev != nullptr && drained.load() >= ev->at)
        {
            const auto e = *ev;
            closeTake();
            if (e.type == startEvent) openTake (e.bpm);
            eventFifo.finishedRead (1); // only now, so flushForTesting waits for the take to be saved
            didSomething = true;
        }

        if (! didSomething)
            wait (15);
    }
    closeTake();
}

void TakeRecorder::openTake (double bpm)
{
    tempFile = folder.getChildFile (".recording-" + juce::Uuid().toString() + ".wav");
    std::unique_ptr<juce::OutputStream> stream = std::make_unique<juce::FileOutputStream> (tempFile);
    if (! static_cast<juce::FileOutputStream*> (stream.get())->openedOk())
        return;
    juce::WavAudioFormat wav;
    writer = wav.createWriterFor (stream, juce::AudioFormatWriterOptions{}
                                              .withSampleRate (sampleRate)
                                              .withNumChannels (channels)
                                              .withBitsPerSample (24));
    takeBpm = bpm;
    framesWritten = 0;
    lastLoudFrame = 0;
    heardSound = false;
}

void TakeRecorder::writeFrames (const float* in, int frames)
{
    int first = 0;
    if (! heardSound)
    {
        while (first < frames && std::abs (in[first * channels]) < silence && std::abs (in[first * channels + 1]) < silence)
            ++first;
        if (first == frames) return;
        heardSound = true;
    }
    const int n = frames - first;
    scratch.resize ((size_t) n * channels);
    float* planar[channels] = { scratch.data(), scratch.data() + n };
    for (int i = 0; i < n; ++i)
    {
        const float l = in[(first + i) * channels], r = in[(first + i) * channels + 1];
        planar[0][i] = l;
        planar[1][i] = r;
        if (std::abs (l) >= silence || std::abs (r) >= silence)
            lastLoudFrame = framesWritten + (juce::uint64) i + 1;
    }
    writer->writeFromFloatArrays (planar, channels, n);
    framesWritten += (juce::uint64) n;
}

void TakeRecorder::closeTake()
{
    if (writer == nullptr)
        return;
    writer.reset(); // flushes and closes the temp file

    const double seconds = (double) lastLoudFrame / sampleRate;
    if (! heardSound || seconds < minSeconds)
    {
        tempFile.deleteFile();
        return;
    }

    // keep a short tail after the last sound, drop the rest of the silence
    const auto keep = (juce::int64) juce::jmin<juce::uint64> (framesWritten, lastLoudFrame + (juce::uint64) (0.4 * sampleRate));
    const auto now = juce::Time::getCurrentTime();
    juce::String name = "Take " + now.formatted ("%Y-%m-%d %H.%M.%S");
    if (takeBpm > 0) name << " " << juce::String (juce::roundToInt (takeBpm)) << " BPM";
    const auto finalFile = folder.getChildFile (name + ".wav").getNonexistentSibling();

    bool ok = false;
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatReader> reader (wav.createReaderFor (tempFile.createInputStream().release(), true));
        std::unique_ptr<juce::OutputStream> out = std::make_unique<juce::FileOutputStream> (finalFile);
        if (reader != nullptr && static_cast<juce::FileOutputStream*> (out.get())->openedOk())
            if (auto w = wav.createWriterFor (out, juce::AudioFormatWriterOptions{}
                                                     .withSampleRate (sampleRate)
                                                     .withNumChannels (channels)
                                                     .withBitsPerSample (24)))
                ok = w->writeFromAudioReader (*reader, 0, keep);
    }
    tempFile.deleteFile();
    if (! ok)
    {
        finalFile.deleteFile();
        return;
    }

    Take t;
    t.id = juce::Uuid().toString().substring (0, 12);
    t.name = finalFile.getFileNameWithoutExtension();
    t.file = finalFile;
    t.seconds = (double) keep / sampleRate;
    t.bpm = takeBpm;
    t.sampleRate = sampleRate;
    t.time = now;
    {
        const juce::ScopedLock sl (takesLock);
        takes.insert (0, t);
        while (takes.size() > 50) takes.removeLast();
    }
    saveIndex();

    juce::MessageManager::callAsync ([this, flag = alive, t]
    {
        if (*flag && onTakeReady)
            onTakeReady (t);
    });
}

juce::Array<TakeRecorder::Take> TakeRecorder::getTakes() const
{
    const juce::ScopedLock sl (takesLock);
    return takes;
}

std::optional<TakeRecorder::Take> TakeRecorder::findTake (const juce::String& id) const
{
    const juce::ScopedLock sl (takesLock);
    for (auto& t : takes)
        if (t.id == id)
            return t;
    return std::nullopt;
}

void TakeRecorder::loadIndex()
{
    auto parsed = juce::JSON::parse (folder.getChildFile ("takes.json"));
    if (auto* arr = parsed.getArray())
        for (auto& v : *arr)
        {
            Take t;
            t.id = v["id"].toString();
            t.file = folder.getChildFile (v["file"].toString());
            t.name = t.file.getFileNameWithoutExtension();
            t.seconds = (double) v["seconds"];
            t.bpm = (double) v["bpm"];
            t.sampleRate = (double) v["sampleRate"];
            t.time = juce::Time ((juce::int64) v["time"]);
            if (t.id.isNotEmpty() && t.file.existsAsFile())
                takes.add (t);
        }
}

void TakeRecorder::saveIndex() const
{
    juce::Array<juce::var> arr;
    for (auto& t : getTakes())
        arr.add (t.toVar());
    folder.getChildFile ("takes.json").replaceWithText (juce::JSON::toString (juce::var (arr)));
}

void TakeRecorder::flushForTesting (int timeoutMs)
{
    const auto until = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;
    while (juce::Time::getMillisecondCounter() < until)
    {
        if (drained.load() >= pushed.load() && eventFifo.getNumReady() == 0)
        {
            juce::Thread::sleep (60);
            if (drained.load() >= pushed.load() && eventFifo.getNumReady() == 0)
                return;
        }
        juce::Thread::sleep (10);
    }
}
