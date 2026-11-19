#include "PluginEditor.h"

using namespace juce;

static const Colour bg (0xff0b0a09), cream (0xffefe8da), gold (0xffe3b062), muted (0xffa69e8f);

static var object (std::initializer_list<std::pair<const char*, var>> props)
{
    DynamicObject::Ptr o = new DynamicObject();
    for (auto& p : props)
        o->setProperty (p.first, p.second);
    return var (o.get());
}

static MemoryBlock fromBase64 (const String& b64)
{
    MemoryOutputStream out;
    Base64::convertFromBase64 (out, b64);
    return out.getMemoryBlock();
}

// audio to the page: 16-bit interleaved PCM in base64
static var toPCM (const AudioBuffer<float>& b, double sr, const String& name)
{
    const int ch = jmax (1, jmin (2, b.getNumChannels())), n = b.getNumSamples();
    MemoryBlock pcm ((size_t) n * (size_t) ch * 2);
    auto* out = static_cast<int16*> (pcm.getData());
    for (int i = 0; i < n; ++i)
        for (int c = 0; c < ch; ++c)
            out[i * ch + c] = (int16) jlimit (-32767, 32767, roundToInt (b.getSample (c, i) * 32767.0f));
    return object ({ { "sampleRate", sr }, { "channels", ch }, { "frames", n }, { "name", name },
                     { "data", Base64::toBase64 (pcm.getData(), pcm.getSize()) } });
}

static bool writeWav (const File& f, const AudioBuffer<float>& b, double sr)
{
    f.deleteFile();
    std::unique_ptr<OutputStream> os = f.createOutputStream();
    if (os == nullptr) return false;
    WavAudioFormat wav;
    auto w = wav.createWriterFor (os, AudioFormatWriterOptions{}.withSampleRate (sr).withNumChannels (b.getNumChannels()).withBitsPerSample (24));
    return w != nullptr && w->writeFromAudioSampleBuffer (b, 0, b.getNumSamples());
}

static File renderFile (const LiftoffProcessor::Render& r)
{
    auto dir = LiftoffProcessor::dataDir().getChildFile ("Transitions");
    dir.createDirectory();
    return dir.getChildFile (File::createLegalFileName (r.name.isEmpty() ? String ("Liftoff transition") : r.name) + ".wav");
}

//==============================================================================
WavDragStrip::WavDragStrip (LiftoffProcessor& p) : proc (p)
{
    setMouseCursor (MouseCursor::DraggingHandCursor);
    setTitle ("Drag the transition into your DAW");
}

void WavDragStrip::paint (Graphics& g)
{
    g.fillAll (bg);
    g.setColour (Colours::white.withAlpha (0.06f));
    g.fillRect (0, 0, getWidth(), 1);
    auto r = proc.currentRender();
    auto tile = getLocalBounds().toFloat().reduced (10.0f, 8.0f);
    g.setColour (gold.withAlpha (r != nullptr ? 0.10f : 0.04f));
    g.fillRoundedRectangle (tile, 8.0f);
    Path outline, dashed;
    outline.addRoundedRectangle (tile, 8.0f);
    const float dashes[] = { 5.0f, 4.0f };
    PathStrokeType (1.5f).createDashedStroke (dashed, outline, dashes, 2);
    g.setColour (gold.withAlpha (r != nullptr ? 0.7f : 0.25f));
    g.fillPath (dashed);
    auto inner = tile.reduced (14.0f, 8.0f);

    if (r == nullptr)
    {
        g.setColour (muted);
        g.setFont (FontOptions (13.0f));
        g.drawText ("your riser appears here, ready to drag into your DAW: load or record a sample", inner, Justification::centred);
        return;
    }
    // a grip, then the riser as a clip
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 2; ++j)
            g.fillEllipse (inner.getX() + (float) j * 5.0f, inner.getCentreY() - 8.0f + (float) i * 7.0f, 2.6f, 2.6f);
    auto clip = inner.withTrimmedLeft (18.0f).withWidth (jmin (inner.getWidth() * 0.5f, 520.0f));
    if (thumbFor != r.get())   // the waveform, once per render
    {
        thumbFor = r.get();
        const int cols = 220, n = r->audio.getNumSamples();
        thumb.assign ((size_t) cols, 0.0f);
        float mx = 0.001f;
        for (int c = 0; c < cols; ++c)
        {
            const int s0 = (int) ((int64) c * n / cols), s1 = (int) ((int64) (c + 1) * n / cols);
            float m = 0.0f;
            for (int ch = 0; ch < r->audio.getNumChannels(); ++ch)
                m = jmax (m, r->audio.getMagnitude (ch, s0, jmax (1, s1 - s0)));
            thumb[(size_t) c] = m; mx = jmax (mx, m);
        }
        for (auto& v : thumb) v /= mx;
    }
    g.setColour (Colours::black.withAlpha (0.35f));
    g.fillRoundedRectangle (clip, 5.0f);
    const float cw = clip.getWidth() / (float) thumb.size(), mid = clip.getCentreY(), half = clip.getHeight() * 0.42f;
    for (size_t c = 0; c < thumb.size(); ++c)
    {
        const float h = jmax (1.0f, thumb[c] * half);
        g.setColour (gold.withAlpha (0.45f + 0.55f * (float) c / (float) thumb.size()));
        g.fillRect (clip.getX() + (float) c * cw, mid - h, jmax (1.0f, cw - 0.5f), h * 2.0f);
    }
    auto text = inner.withTrimmedLeft (clip.getRight() - inner.getX() + 16.0f);
    g.setColour (cream);
    g.setFont (FontOptions (14.0f, Font::bold));
    g.drawText ("DRAG into your DAW", text.removeFromTop (text.getHeight() * 0.55f), Justification::bottomLeft);
    g.setColour (muted);
    g.setFont (FontOptions (12.0f));
    g.drawText (r->name + "  ·  " + String ((double) r->audio.getNumSamples() / r->sampleRate, 2) + " s  ·  24-bit WAV", text, Justification::topLeft);
}

void WavDragStrip::mouseDrag (const MouseEvent& e)
{
    auto r = proc.currentRender();
    if (dragging || e.getDistanceFromDragStart() < 5 || r == nullptr)
        return;
    dragging = true;
    const auto file = renderFile (*r);
    if (! writeWav (file, r->audio, r->sampleRate)) { dragging = false; return; }
    DragAndDropContainer::performExternalDragDropOfFiles ({ file.getFullPathName() }, false, this, [this] { dragging = false; });
}

//==============================================================================
LiftoffEditor::LiftoffEditor (LiftoffProcessor& p)
    : AudioProcessorEditor (&p), proc (p),
      lastDir (File::getSpecialLocation (File::userMusicDirectory)),
      web (makeOptions()), strip (p)
{
    addAndMakeVisible (web);
    addChildComponent (strip);
    // the unit is drawn at 1200 x 791 and scales to the window; the tray (the drag strip) sits under it
    setResizable (true, true);
    setResizeLimits (600, 420, 2400, 1700);
    setSize (1200, 791 + stripHeight);
    web.goToURL (WebBrowserComponent::getResourceProviderRoot());
    startTimerHz (30);
}

LiftoffEditor::~LiftoffEditor() { stopTimer(); }

void LiftoffEditor::paint (Graphics& g) { g.fillAll (bg); }

void LiftoffEditor::resized()
{
    auto r = getLocalBounds();
    strip.setVisible (proc.sampleView);
    if (proc.sampleView)
        strip.setBounds (r.removeFromBottom (stripHeight));
    web.setBounds (r);
}

std::optional<WebBrowserComponent::Resource> LiftoffEditor::resource (const String& url)
{
    auto path = url.upToFirstOccurrenceOf ("?", false, false).trimCharactersAtStart ("/");
    if (path.isEmpty())
        path = "index.html";
    int size = 0;
    const char* data = findResource (path, size);
    if (data == nullptr)
        return std::nullopt;
    WebBrowserComponent::Resource res;
    res.data.resize ((size_t) size);
    std::memcpy (res.data.data(), data, (size_t) size);
    const auto ext = path.fromLastOccurrenceOf (".", false, false).toLowerCase();
    res.mimeType = ext == "html" ? "text/html" : ext == "js" ? "text/javascript" : ext == "css" ? "text/css" : "application/octet-stream";
    return res;
}

var LiftoffEditor::values() const
{
    DynamicObject::Ptr o = new DynamicObject();
    for (auto* p : proc.getParameters())
        if (auto* rp = dynamic_cast<RangedAudioParameter*> (p))
            o->setProperty (rp->getParameterID(), rp->convertFrom0to1 (rp->getValue()));
    return var (o.get());
}

void LiftoffEditor::choose (const String& title, const File& start, const String& pattern, int browseFlags, std::function<void (const File&)> then)
{
    chooser = std::make_unique<FileChooser> (title, start, pattern);
    chooser->launchAsync (browseFlags, [this, then] (const FileChooser& fc)
    {
        const auto f = fc.getResult();
        if (f != File())
            lastDir = f.getParentDirectory();
        then (f);
    });
}

var LiftoffEditor::loadSample (const File& f)
{
    std::unique_ptr<AudioFormatReader> reader (proc.formats.createReaderFor (f));
    if (reader == nullptr || reader->sampleRate <= 0)
        return {};
    const int n = (int) jmin (reader->lengthInSamples, (int64) (reader->sampleRate * 60.0));   // a minute is plenty
    const int ch = (int) jmin (2u, reader->numChannels);
    AudioBuffer<float> b (ch, n);
    reader->read (&b, 0, n, 0, true, ch > 1);
    return toPCM (b, reader->sampleRate, f.getFileName());
}

WebBrowserComponent::Options LiftoffEditor::makeOptions()
{
    using O = WebBrowserComponent::Options;
    const auto dir = LiftoffProcessor::dataDir();

    return O{}
        .withBackend (O::Backend::webview2)
        .withWinWebView2Options (O::WinWebView2{}.withUserDataFolder (dir.getChildFile ("WebView2")))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([this] (const String& url) { return resource (url); })

        // parameters
        .withNativeFunction ("getParams", [this] (const Array<var>&, Completion done)
        {
            auto v = values();
            if (auto* o = v.getDynamicObject())
                for (auto& nv : o->getProperties())
                    sent[nv.name.toString()] = (float) (double) nv.value;
            done (object ({ { "values", v }, { "preset", proc.preset.load() }, { "ui", proc.uiJson },
                            { "sr", proc.getSampleRate() > 0 ? proc.getSampleRate() : 48000.0 }, { "bpm", proc.ui.bpm.load() } }));
        })
        .withNativeFunction ("setParam", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() >= 2)
                if (auto* p = proc.apvts.getParameter (a[0].toString()))
                {
                    const float v = (float) (double) a[1];
                    sent[a[0].toString()] = v;
                    p->setValueNotifyingHost (p->convertTo0to1 (v));
                }
            done (var());
        })
        .withNativeFunction ("gesture", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() >= 2)
                if (auto* p = proc.apvts.getParameter (a[0].toString()))
                {
                    if ((bool) a[1]) p->beginChangeGesture(); else p->endChangeGesture();
                }
            done (var());
        })
        .withNativeFunction ("launch", [this] (const Array<var>&, Completion done) { proc.launchRequest = true; done (var()); })
        .withNativeFunction ("setPreset", [this] (const Array<var>& a, Completion done) { if (a.size() > 0) proc.preset = (int) a[0]; done (var()); })
        .withNativeFunction ("setUi", [this] (const Array<var>& a, Completion done) { if (a.size() > 0) proc.uiJson = a[0].toString(); done (var()); })
        .withNativeFunction ("setView", [this] (const Array<var>& a, Completion done)
        {
            proc.sampleView = a.size() > 0 && a[0].toString() == "sample";
            if (! proc.sampleView) { proc.previewing = false; proc.recording = false; }
            resized();
            done (var());
        })

        // SAMPLE mode: the sample
        .withNativeFunction ("recStart", [this] (const Array<var>&, Completion done) { proc.previewing = false; proc.startRecording(); done (var()); })
        .withNativeFunction ("recStop", [this, dir] (const Array<var>&, Completion done)
        {
            const auto b = proc.stopRecording();
            const double sr = proc.getSampleRate() > 0 ? proc.getSampleRate() : 48000.0;
            if (b.getNumSamples() < 64) { done (var()); return; }
            // keep the take, so the session finds it again
            auto recs = dir.getChildFile ("Recordings");
            recs.createDirectory();
            const auto f = recs.getNonexistentChildFile ("Recording " + Time::getCurrentTime().formatted ("%Y-%m-%d %H.%M.%S"), ".wav");
            if (writeWav (f, b, sr))
                proc.samplePath = f.getFullPathName();
            done (toPCM (b, sr, f.getFileNameWithoutExtension()));
        })
        .withNativeFunction ("pickSample", [this] (const Array<var>&, Completion done)
        {
            choose ("Choose a sample", lastDir, proc.formats.getWildcardForAllFormats(),
                    FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles,
                    [this, done] (const File& f)
                    {
                        if (f == File()) { done (var()); return; }
                        auto v = loadSample (f);
                        if (! v.isVoid()) proc.samplePath = f.getFullPathName();
                        done (v);
                    });
        })
        .withNativeFunction ("storeSample", [this, dir] (const Array<var>& a, Completion done)
        {
            // a file dropped on the page: keep a copy so the session can find it again
            if (a.size() < 2) { done (var()); return; }
            const String name = File::createLegalFileName (a[0].toString());
            auto samples = dir.getChildFile ("Samples");
            samples.createDirectory();
            auto f = samples.getNonexistentChildFile (name.upToLastOccurrenceOf (".", false, false), name.fromLastOccurrenceOf (".", true, false));
            const auto bytes = fromBase64 (a[1].toString());
            if (f.replaceWithData (bytes.getData(), bytes.getSize()))
                proc.samplePath = f.getFullPathName();
            done (var());
        })
        .withNativeFunction ("getSample", [this] (const Array<var>&, Completion done)
        {
            const File f (proc.samplePath);
            done (proc.samplePath.isNotEmpty() && f.existsAsFile() ? loadSample (f) : var());
        })

        // SAMPLE mode: the transition the page rendered
        .withNativeFunction ("setRender", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() < 3) { done (var()); return; }
            const auto bytes = fromBase64 (a[0].toString());
            const int n = (int) (bytes.getSize() / 4);   // stereo 16-bit
            auto r = std::make_shared<LiftoffProcessor::Render>();
            r->sampleRate = (double) a[1];
            r->name = a[2].toString();
            r->audio.setSize (2, n);
            const auto* pcm = static_cast<const int16*> (bytes.getData());
            for (int i = 0; i < n; ++i)
                for (int c = 0; c < 2; ++c)
                    r->audio.setSample (c, i, (float) pcm[i * 2 + c] / 32767.0f);
            proc.setRender (r);
            strip.repaint();
            done (var());
        })
        .withNativeFunction ("preview", [this] (const Array<var>& a, Completion done)
        {
            proc.preview (a.size() > 0 && (bool) a[0], a.size() > 1 ? (int64) (double) a[1] : 0);
            done (var());
        })
        .withNativeFunction ("audition", [this] (const Array<var>& a, Completion done)
        {
            // the part of the sample you chose, played once through the plugin's output
            if (a.size() < 2) { done (var()); return; }
            const auto bytes = fromBase64 (a[0].toString());
            const int n = (int) (bytes.getSize() / 4);
            auto r = std::make_shared<LiftoffProcessor::Render>();
            r->sampleRate = (double) a[1];
            r->audio.setSize (2, n);
            const auto* pcm = static_cast<const int16*> (bytes.getData());
            for (int i = 0; i < n; ++i)
                for (int c = 0; c < 2; ++c)
                    r->audio.setSample (c, i, (float) pcm[i * 2 + c] / 32767.0f);
            proc.audition (r);
            done (var());
        })
        .withNativeFunction ("saveRender", [this] (const Array<var>&, Completion done)
        {
            auto r = proc.currentRender();
            if (r == nullptr) { done (String()); return; }
            choose ("Save the transition", lastDir.getChildFile (renderFile (*r).getFileName()), "*.wav",
                    FileBrowserComponent::saveMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::warnAboutOverwriting,
                    [r, done] (const File& f)
                    {
                        done (f != File() && writeWav (f.withFileExtension ("wav"), r->audio, r->sampleRate) ? f.getFullPathName() : String());
                    });
        });
}

void LiftoffEditor::timerCallback()
{
    // parameters the DAW changed (automation, undo, a loaded session) go to the page
    DynamicObject::Ptr changed = new DynamicObject();
    for (auto* p : proc.getParameters())
        if (auto* rp = dynamic_cast<RangedAudioParameter*> (p))
        {
            const auto id = rp->getParameterID();
            const float v = rp->convertFrom0to1 (rp->getValue());
            auto it = sent.find (id);
            if (it == sent.end() || std::abs (it->second - v) > 1e-5f * jmax (1.0f, std::abs (v)))
            {
                sent[id] = v;
                changed->setProperty (id, v);
            }
        }
    if (! changed->getProperties().isEmpty())
        web.emitEventIfBrowserIsVisible ("params", var (changed.get()));

    if (strip.isVisible() != (bool) proc.sampleView)
        resized();

    auto& u = proc.ui;
    const double sr = proc.getSampleRate() > 0 ? proc.getSampleRate() : 48000.0;
    auto r = proc.currentRender();
    web.emitEventIfBrowserIsVisible ("state", object ({
        { "p", u.p.load() }, { "raw", u.raw.load() }, { "toDrop", u.toDrop.load() }, { "beat", u.beat.load() },
        { "inGap", u.inGap.load() }, { "trig", u.trig.load() }, { "pending", u.pending.load() },
        { "playing", u.hostPlaying.load() }, { "hostPlaying", u.hostPlaying.load() }, { "drops", u.drops.load() },
        { "peakIn", u.peakIn.exchange (0.0f) }, { "peakOut", u.peakOut.exchange (0.0f) },
        { "bpm", u.bpm.load() }, { "bpb", u.bpb.load() }, { "latency", proc.getLatencySamples() }, { "sr", sr },
        { "previewing", proc.previewing.load() && ! proc.auditioning.load() },
        { "previewPos", r != nullptr ? (double) proc.previewPos.load() / r->sampleRate : 0.0 },
        { "recording", proc.recording.load() }, { "recSeconds", (double) proc.recPos.load() / sr },
        { "recLevel", proc.recLevel.exchange (0.0f) } }));
}
