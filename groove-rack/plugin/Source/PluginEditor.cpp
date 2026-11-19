#include "PluginEditor.h"

using namespace juce;

// the GR-16 palette from the web UI
static const Colour bg (0xff0c0e14), panel (0xff0c0e14), cream (0xfff3f4f6), gold (0xff49e8d0), muted (0xff7c818d);

//==============================================================================
MidiDragStrip::MidiDragStrip (GrooveRackProcessor& p) : proc (p)
{
    setMouseCursor (MouseCursor::DraggingHandCursor);
    setTitle ("Drag MIDI into your DAW");
}

void MidiDragStrip::paint (Graphics& g)
{
    g.fillAll (panel);
    g.setColour (Colours::white.withAlpha (0.08f));
    g.fillRect (0, 0, getWidth(), 1);
    // a dashed outline like the DRAG MIDI pad in the UI
    Path outline;
    outline.addRoundedRectangle (getLocalBounds().toFloat().reduced (6.0f, 5.0f), 7.0f);
    Path dashed;
    const float dashes[] = { 5.0f, 4.0f };
    PathStrokeType (1.5f).createDashedStroke (dashed, outline, dashes, 2);
    g.setColour (gold.withAlpha (0.45f));
    g.fillPath (dashed);
    auto r = getLocalBounds().reduced (14, 0);
    Path arrow;   // a small down-right arrow in gold
    const float cy = (float) getHeight() * 0.5f, x = (float) r.getX();
    arrow.startNewSubPath (x, cy - 6); arrow.lineTo (x + 10, cy - 6); arrow.lineTo (x + 10, cy + 4);
    arrow.startNewSubPath (x + 5, cy + 1); arrow.lineTo (x + 10, cy + 6); arrow.lineTo (x + 15, cy + 1);
    g.setColour (gold);
    g.strokePath (arrow, PathStrokeType (2.0f, PathStrokeType::curved, PathStrokeType::rounded));
    g.setColour (cream);
    g.setFont (FontOptions (13.0f, Font::bold));
    g.drawText ("DRAG MIDI into your DAW", r.withTrimmedLeft (24), Justification::centredLeft);
    g.setColour (muted);
    g.setFont (FontOptions (12.5f));
    g.drawText ("drums on channel 10, bass on its own channel", r, Justification::centredRight);
}

void MidiDragStrip::mouseDrag (const MouseEvent& e)
{
    if (dragging || e.getDistanceFromDragStart() < 5 || proc.midiFile.getSize() == 0)
        return;
    dragging = true;
    auto file = File::getSpecialLocation (File::tempDirectory).getChildFile ("Groove Rack loop.mid");
    file.replaceWithData (proc.midiFile.getData(), proc.midiFile.getSize());
    DragAndDropContainer::performExternalDragDropOfFiles ({ file.getFullPathName() }, false, this, [this] { dragging = false; });
}

//==============================================================================
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

GrooveRackEditor::GrooveRackEditor (GrooveRackProcessor& p)
    : AudioProcessorEditor (&p), proc (p),
      lastDir (File::getSpecialLocation (File::userMusicDirectory)),
      web (makeOptions()), strip (p)
{
    addAndMakeVisible (web);
    addAndMakeVisible (strip);
    setResizable (true, true);
    setResizeLimits (420, 400, 2600, 2400);
    setSize (1180, 900);   // the page then fits the height to the machine
    reloadPage();
    startTimerHz (30);
}

GrooveRackEditor::~GrooveRackEditor() { stopTimer(); }

void GrooveRackEditor::reloadPage() { web.goToURL (WebBrowserComponent::getResourceProviderRoot()); }

void GrooveRackEditor::paint (Graphics& g) { g.fillAll (bg); }

void GrooveRackEditor::resized()
{
    auto r = getLocalBounds();
    strip.setBounds (r.removeFromBottom (stripHeight));
    web.setBounds (r);
}

std::optional<WebBrowserComponent::Resource> GrooveRackEditor::resource (const String& url)
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
    res.mimeType = ext == "html" ? "text/html" : ext == "js" ? "text/javascript" : ext == "json" ? "application/json"
                 : ext == "css" ? "text/css" : ext == "wav" ? "audio/wav" : "application/octet-stream";
    return res;
}

void GrooveRackEditor::choose (const String& title, const File& start, const String& pattern, int browseFlags,
                               std::function<void (const File&)> then)
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

WebBrowserComponent::Options GrooveRackEditor::makeOptions()
{
    using O = WebBrowserComponent::Options;
    const auto dataDir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Groove Rack");

    return O{}
        .withBackend (O::Backend::webview2)
        .withWinWebView2Options (O::WinWebView2{}.withUserDataFolder (dataDir.getChildFile ("WebView2")))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([this] (const String& url) { return resource (url); })

        .withNativeFunction ("getProject", [this] (const Array<var>&, Completion done) { done (proc.getProjectJSON()); })
        .withNativeFunction ("setProject", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() > 0) proc.setProjectJSON (a[0].toString());
            if (a.size() > 1) proc.midiFile = fromBase64 (a[1].toString());
            done (var());
        })
        .withNativeFunction ("setPlaying", [this] (const Array<var>& a, Completion done) { proc.engine.internalPlay = a.size() > 0 && (bool) a[0]; done (var()); })
        .withNativeFunction ("seek", [this] (const Array<var>& a, Completion done) { if (a.size() > 0) proc.engine.seekBar = (int) a[0]; done (var()); })
        .withNativeFunction ("fitHeight", [this] (const Array<var>& a, Completion done)
        {
            // the page asks for the machine's height: the window takes it, up to the screen's height
            const int h = a.size() > 0 ? (int) a[0] : 0;
            Component::SafePointer<GrooveRackEditor> safe (this);
            MessageManager::callAsync ([safe, h]
            {
                if (safe == nullptr || h < 200)
                    return;
                int maxH = 2400;
                if (auto* d = Desktop::getInstance().getDisplays().getDisplayForRect (safe->getScreenBounds()))
                    maxH = d->userArea.getHeight() - 60;
                const int want = jlimit (400, jmax (400, maxH), h + stripHeight);
                if (std::abs (want - safe->getHeight()) > 2)
                    safe->setSize (safe->getWidth(), want);
            });
            done (var());
        })
        .withNativeFunction ("setMuted", [this] (const Array<var>& a, Completion done) { proc.engine.muted = a.size() > 0 && (bool) a[0]; done (var()); })
        .withNativeFunction ("audition", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() >= 3)
                proc.engine.audition (proc.trackIndex (a[0].toString()), (int) a[1], (float) (double) a[2]);
            done (var());
        })
        .withNativeFunction ("pickSample", [this] (const Array<var>&, Completion done)
        {
            choose ("Choose a sample", lastDir, proc.bank.formats.getWildcardForAllFormats(),
                    FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles,
                    [done] (const File& f)
                    {
                        done (f == File() ? var() : object ({ { "path", f.getFullPathName() }, { "name", f.getFileName() } }));
                    });
        })
        .withNativeFunction ("storeSample", [dataDir] (const Array<var>& a, Completion done)
        {
            // a file dropped on the page: keep a copy so the project can find it again
            if (a.size() < 2) { done (var()); return; }
            const String name = File::createLegalFileName (a[0].toString());
            auto dir = dataDir.getChildFile ("Samples");
            dir.createDirectory();
            auto f = dir.getNonexistentChildFile (name.upToLastOccurrenceOf (".", false, false), name.fromLastOccurrenceOf (".", true, false));
            const auto bytes = fromBase64 (a[1].toString());
            done (f.replaceWithData (bytes.getData(), bytes.getSize())
                      ? object ({ { "path", f.getFullPathName() }, { "name", name } }) : var());
        })
        .withNativeFunction ("getSample", [this] (const Array<var>& a, Completion done)
        {
            // the UI draws waveforms and bounces WAVs itself, so it gets the audio as 16-bit PCM
            const String path = a.size() > 0 ? a[0].toString() : String();
            if (! File::isAbsolutePath (path)) { done (var()); return; }
            std::unique_ptr<AudioFormatReader> reader (proc.bank.formats.createReaderFor (File (path)));
            if (reader == nullptr) { done (var()); return; }
            auto s = gr::SampleBank::decode (*reader, 30.0);
            if (s == nullptr) { done (var()); return; }
            const int ch = s->buffer.getNumChannels(), frames = s->buffer.getNumSamples();
            MemoryBlock pcm ((size_t) frames * (size_t) ch * 2);
            auto* out = static_cast<int16*> (pcm.getData());
            for (int i = 0; i < frames; ++i)
                for (int c = 0; c < ch; ++c)
                    out[i * ch + c] = (int16) jlimit (-32767, 32767, roundToInt (s->buffer.getSample (c, i) * 32767.0f));
            done (object ({ { "sampleRate", s->sampleRate }, { "channels", ch }, { "frames", frames },
                            { "data", Base64::toBase64 (pcm.getData(), pcm.getSize()) } }));
        })
        .withNativeFunction ("saveFile", [this] (const Array<var>& a, Completion done)
        {
            if (a.size() < 2) { done (String()); return; }
            const String name = File::createLegalFileName (a[0].toString());
            auto bytes = std::make_shared<MemoryBlock> (fromBase64 (a[1].toString()));
            choose ("Save " + name, lastDir.getChildFile (name), "*" + name.fromLastOccurrenceOf (".", true, false),
                    FileBrowserComponent::saveMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::warnAboutOverwriting,
                    [done, bytes] (const File& f)
                    {
                        done (f != File() && f.replaceWithData (bytes->getData(), bytes->getSize()) ? f.getFullPathName() : String());
                    });
        })
        .withNativeFunction ("openFile", [this] (const Array<var>& a, Completion done)
        {
            const String pattern = a.size() > 0 ? a[0].toString() : String ("*");
            choose ("Open", lastDir, pattern, FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles,
                    [done] (const File& f)
                    {
                        MemoryBlock mb;
                        if (f == File() || ! f.loadFileAsData (mb)) { done (var()); return; }
                        done (object ({ { "name", f.getFileName() }, { "data", Base64::toBase64 (mb.getData(), mb.getSize()) } }));
                    });
        });
}

void GrooveRackEditor::timerCallback()
{
    DynamicObject::Ptr levels = new DynamicObject();
    if (auto p = proc.engine.latestPattern())
    {
        for (int i = 0; i < (int) p->tracks.size() && i < gr::Engine::maxTracks; ++i)
        {
            Array<var> l;
            l.add (proc.engine.peak[(size_t) i].exchange (0.0f));
            l.add (proc.engine.rms[(size_t) i].exchange (0.0f));
            levels->setProperty (p->tracks[(size_t) i].id, l);
        }
    }
    web.emitEventIfBrowserIsVisible ("state", object ({
        { "playing", proc.engine.uiPlaying.load() },
        { "host", proc.engine.uiHost.load() },
        { "tick", proc.engine.uiTick.load() },
        { "bpm", proc.engine.uiBpm.load() },
        { "daw", proc.engine.uiDawTempo.load() },
        { "levels", var (levels.get()) } }));
}
