#include "PluginEditor.h"

using namespace juce;

static var object (std::initializer_list<std::pair<const char*, var>> props)
{
    DynamicObject::Ptr o = new DynamicObject();
    for (auto& p : props)
        o->setProperty (p.first, p.second);
    return var (o.get());
}

LiftoffEditor::LiftoffEditor (LiftoffProcessor& p)
    : AudioProcessorEditor (&p), proc (p), web (makeOptions())
{
    addAndMakeVisible (web);
    setResizable (true, true);
    setResizeLimits (420, 420, 2400, 2000);
    setSize (1120, 840);
    web.goToURL (WebBrowserComponent::getResourceProviderRoot());
    startTimerHz (30);
}

LiftoffEditor::~LiftoffEditor() { stopTimer(); }

void LiftoffEditor::paint (Graphics& g) { g.fillAll (Colour (0xff07080f)); }
void LiftoffEditor::resized() { web.setBounds (getLocalBounds()); }

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

WebBrowserComponent::Options LiftoffEditor::makeOptions()
{
    using O = WebBrowserComponent::Options;
    const auto dataDir = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Liftoff");

    return O{}
        .withBackend (O::Backend::webview2)
        .withWinWebView2Options (O::WinWebView2{}.withUserDataFolder (dataDir.getChildFile ("WebView2")))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([this] (const String& url) { return resource (url); })

        .withNativeFunction ("getParams", [this] (const Array<var>&, Completion done)
        {
            auto v = values();
            if (auto* o = v.getDynamicObject())
                for (auto& nv : o->getProperties())
                    sent[nv.name.toString()] = (float) (double) nv.value;
            done (object ({ { "values", v }, { "preset", proc.preset.load() } }));
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
        .withNativeFunction ("setPreset", [this] (const Array<var>& a, Completion done) { if (a.size() > 0) proc.preset = (int) a[0]; done (var()); });
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

    auto& u = proc.ui;
    web.emitEventIfBrowserIsVisible ("state", object ({
        { "p", u.p.load() }, { "raw", u.raw.load() }, { "toDrop", u.toDrop.load() }, { "beat", u.beat.load() },
        { "inGap", u.inGap.load() }, { "trig", u.trig.load() }, { "pending", u.pending.load() },
        { "playing", u.hostPlaying.load() }, { "hostPlaying", u.hostPlaying.load() }, { "drops", u.drops.load() },
        { "peakIn", u.peakIn.exchange (0.0f) }, { "peakOut", u.peakOut.exchange (0.0f) },
        { "bpm", u.bpm.load() }, { "bpb", u.bpb.load() }, { "latency", proc.getLatencySamples() }, { "sr", proc.getSampleRate() } }));
}
