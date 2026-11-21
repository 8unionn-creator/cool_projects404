#include "PluginEditor.h"
#include "SpinRoomWebData.h"

#if JucePlugin_Build_Standalone
 #include <juce_audio_devices/juce_audio_devices.h>
 #include <juce_audio_utils/juce_audio_utils.h>
 #include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#endif

using Resource = juce::WebBrowserComponent::Resource;

namespace
{
    /*  Rewrites UTF-8 text as plain ASCII so no web view can mis-guess its encoding:
        characters outside ASCII become &#x...; in HTML, \u escapes in scripts and CSS escapes in styles. */
    std::string asciiSafe (const char* d, size_t n)
    {
        std::string out;
        out.reserve (n + n / 16);
        bool inScript = false, inStyle = false;
        const auto at = [&] (size_t i, const char* s) { const auto len = std::strlen (s); return i + len <= n && std::memcmp (d + i, s, len) == 0; };
        for (size_t i = 0; i < n;)
        {
            const auto c = static_cast<unsigned char> (d[i]);
            if (c < 0x80)
            {
                if (c == '<')
                {
                    if (at (i, "<script")) inScript = true;
                    else if (at (i, "</script")) inScript = false;
                    else if (at (i, "<style")) inStyle = true;
                    else if (at (i, "</style")) inStyle = false;
                }
                out += static_cast<char> (c);
                ++i;
                continue;
            }
            const size_t len = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
            if (len == 1 || i + len > n) { out += '?'; ++i; continue; }
            uint32_t cp = c & (0xFFu >> (len + 1));
            for (size_t k = 1; k < len; ++k)
                cp = (cp << 6) | (static_cast<unsigned char> (d[i + k]) & 0x3Fu);
            char buf[16];
            if (inScript) std::snprintf (buf, sizeof (buf), cp <= 0xFFFF ? "\\u%04X" : "\\u{%X}", (unsigned) cp);
            else if (inStyle) std::snprintf (buf, sizeof (buf), "\\%X ", (unsigned) cp);
            else std::snprintf (buf, sizeof (buf), "&#x%X;", (unsigned) cp);
            out += buf;
            i += len;
        }
        return out;
    }

    std::optional<Resource> bundled (const juce::String& originalName, const juce::String& mime)
    {
        for (int i = 0; i < SpinRoomWebData::namedResourceListSize; ++i)
            if (originalName == SpinRoomWebData::originalFilenames[i])
            {
                int size = 0;
                const auto* data = SpinRoomWebData::getNamedResource (SpinRoomWebData::namedResourceList[i], size);
                if (data == nullptr) return std::nullopt;
                const auto text = asciiSafe (data, (size_t) size);
                const auto* bytes = reinterpret_cast<const std::byte*> (text.data());
                return Resource { std::vector<std::byte> (bytes, bytes + text.size()), mime };
            }
        return std::nullopt;
    }

    std::optional<Resource> fromFile (const juce::File& f, const juce::String& mime)
    {
        juce::MemoryBlock mb;
        if (! f.loadFileAsData (mb)) return std::nullopt;
        const auto* bytes = static_cast<const std::byte*> (mb.getData());
        return Resource { std::vector<std::byte> (bytes, bytes + mb.getSize()), mime };
    }

    juce::String arg (const juce::Array<juce::var>& args, int i) { return i < args.size() ? args[i].toString() : juce::String(); }
}

SpinRoomEditor::SpinRoomEditor (SpinRoomProcessor& p)
    : AudioProcessorEditor (p), proc (p)
{
   #if JucePlugin_Build_Standalone
    // The standalone app is for catching the audio input, so don't start with it muted.
    if (proc.isStandalone())
        if (auto* holder = juce::StandalonePluginHolder::getInstance())
            holder->getMuteInputValue().setValue (false);
   #endif

    addAndMakeVisible (web);
    setResizable (true, true);
    setResizeLimits (820, 560, 3200, 2200);
    setSize (1280, 820);

    proc.getRecorder().onTakeReady = [this] (const TakeRecorder::Take& t)
    {
        web.emitEventIfBrowserIsVisible ("spinroom_take", t.toVar());
    };

    web.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
    startTimer (150);
}

SpinRoomEditor::~SpinRoomEditor()
{
    proc.getRecorder().onTakeReady = nullptr;
    stopTimer();
}

void SpinRoomEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff0f0e12));
}

void SpinRoomEditor::resized()
{
    web.setBounds (getLocalBounds());
}

juce::var SpinRoomEditor::statusVar() const
{
    auto& r = proc.getRecorder();
    auto* o = new juce::DynamicObject();
    o->setProperty ("recording", r.isRecording());
    o->setProperty ("seconds", std::floor (r.getRecordedSeconds() * 10.0) / 10.0);
    o->setProperty ("auto", r.getAutoCapture());
    o->setProperty ("hostPlaying", r.isHostPlaying());
    o->setProperty ("bpm", r.getHostBpm());
    o->setProperty ("standalone", proc.isStandalone());
    o->setProperty ("takesFolder", SpinRoomProcessor::takesFolder().getFullPathName());
    o->setProperty ("videosFolder", SpinRoomProcessor::videosFolder().getFullPathName());
    o->setProperty ("version", JucePlugin_VersionString);
    return juce::var (o);
}

void SpinRoomEditor::timerCallback()
{
    const auto status = statusVar();
    const auto json = juce::JSON::toString (status, true);
    if (json != lastStatusJson)
    {
        lastStatusJson = json;
        web.emitEventIfBrowserIsVisible ("spinroom_status", status);
    }
}

std::optional<Resource> SpinRoomEditor::getResource (const juce::String& path)
{
    const auto p = path.upToFirstOccurrenceOf ("?", false, false);
    if (p == "/" || p == "/index.html")
        return bundled ("index.html", "text/html; charset=utf-8");
    if (p == "/vendor/mp4-muxer.js")
        return bundled ("mp4-muxer.js", "text/javascript; charset=utf-8");
    if (p.startsWith ("/takes/"))
    {
        const auto id = p.fromLastOccurrenceOf ("/", false, false).upToLastOccurrenceOf (".", false, false);
        if (auto t = proc.getRecorder().findTake (id))
            return fromFile (t->file, "audio/wav");
    }
    return std::nullopt;
}

juce::WebBrowserComponent::Options SpinRoomEditor::makeOptions()
{
    using Args = const juce::Array<juce::var>&;
    using Done = juce::WebBrowserComponent::NativeFunctionCompletion;

    return juce::WebBrowserComponent::Options{}
        .withBackend (juce::WebBrowserComponent::Options::Backend::defaultBackend)
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([this] (const juce::String& path) { return getResource (path); })
        .withNativeFunction ("spinroom_status", [this] (Args, Done done) { done (statusVar()); })
        .withNativeFunction ("spinroom_takes", [this] (Args, Done done)
        {
            juce::Array<juce::var> list;
            for (auto& t : proc.getRecorder().getTakes())
                list.add (t.toVar());
            done (list);
        })
        .withNativeFunction ("spinroom_setAuto", [this] (Args args, Done done)
        {
            proc.getRecorder().setAutoCapture (args.size() > 0 && (bool) args[0]);
            done (statusVar());
        })
        .withNativeFunction ("spinroom_record", [this] (Args, Done done) { proc.getRecorder().record(); done (true); })
        .withNativeFunction ("spinroom_stop", [this] (Args, Done done) { proc.getRecorder().stop(); done (true); })
        .withNativeFunction ("spinroom_getState", [this] (Args, Done done) { done (proc.getWebState()); })
        .withNativeFunction ("spinroom_setState", [this] (Args args, Done done) { proc.setWebState (arg (args, 0)); done (true); })
        .withNativeFunction ("spinroom_copy", [] (Args args, Done done)
        {
            juce::SystemClipboard::copyTextToClipboard (arg (args, 0));
            done (true);
        })
        .withNativeFunction ("spinroom_reveal", [] (Args args, Done done)
        {
            const juce::File f (arg (args, 0));
            if (f.exists()) f.revealToUser();
            done (f.exists());
        })
        .withNativeFunction ("spinroom_openFolder", [] (Args args, Done done)
        {
            auto folder = arg (args, 0) == "videos" ? SpinRoomProcessor::videosFolder() : SpinRoomProcessor::takesFolder();
            folder.createDirectory();
            done (folder.startAsProcess());
        })
        // Videos arrive from the page in base64 pieces and are written to Movies/Spin Room.
        .withNativeFunction ("spinroom_saveBegin", [this] (Args args, Done done)
        {
            auto folder = SpinRoomProcessor::videosFolder();
            folder.createDirectory();
            auto name = juce::File::createLegalFileName (arg (args, 0));
            if (name.isEmpty()) name = "Spin Room video.mp4";
            auto file = folder.getChildFile (name).getNonexistentSibling();
            auto out = std::make_unique<juce::FileOutputStream> (file);
            if (! out->openedOk()) { done (juce::var()); return; }
            const auto token = juce::Uuid().toString();
            saves[token] = { file, std::move (out) };
            done (token);
        })
        .withNativeFunction ("spinroom_saveChunk", [this] (Args args, Done done)
        {
            auto it = saves.find (arg (args, 0));
            done (it != saves.end() && juce::Base64::convertFromBase64 (*it->second.out, arg (args, 1)));
        })
        .withNativeFunction ("spinroom_saveEnd", [this] (Args args, Done done)
        {
            auto it = saves.find (arg (args, 0));
            if (it == saves.end()) { done (juce::var()); return; }
            it->second.out->flush();
            const bool ok = it->second.out->getStatus().wasOk();
            const auto path = it->second.file.getFullPathName();
            it->second.out.reset();
            if (! ok) it->second.file.deleteFile();
            saves.erase (it);
            done (ok ? juce::var (path) : juce::var());
        });
}
