#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

// A strip under the page in SAMPLE mode: drag from it to drop the rendered transition into a DAW track as a WAV.
class WavDragStrip : public juce::Component
{
public:
    explicit WavDragStrip (LiftoffProcessor& p);
    void paint (juce::Graphics&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override { dragging = false; }

private:
    LiftoffProcessor& proc;
    bool dragging = false;
};

// The plugin window is the web page (the same files as the browser version) in a web view.
class LiftoffEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit LiftoffEditor (LiftoffProcessor&);
    ~LiftoffEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;
    void timerCallback() override;
    juce::WebBrowserComponent::Options makeOptions();
    std::optional<juce::WebBrowserComponent::Resource> resource (const juce::String& url);
    juce::var values() const;
    void choose (const juce::String& title, const juce::File& start, const juce::String& pattern, int browseFlags, std::function<void (const juce::File&)> then);
    juce::var loadSample (const juce::File&);   // decoded, as the page's PCM object

    static constexpr int stripHeight = 34;
    LiftoffProcessor& proc;
    std::map<juce::String, float> sent;   // the values the page has, so only host changes are sent back
    std::unique_ptr<juce::FileChooser> chooser;
    juce::File lastDir;
    juce::WebBrowserComponent web;
    WavDragStrip strip;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiftoffEditor)
};
