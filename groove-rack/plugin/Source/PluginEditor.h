#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

// A strip under the UI: drag from it to drop the loop's MIDI into a DAW track.
class MidiDragStrip : public juce::Component
{
public:
    explicit MidiDragStrip (GrooveRackProcessor& p);
    void paint (juce::Graphics&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override { dragging = false; }

private:
    GrooveRackProcessor& proc;
    bool dragging = false;
};

class GrooveRackEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit GrooveRackEditor (GrooveRackProcessor&);
    ~GrooveRackEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;
    void reloadPage();

private:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;
    void timerCallback() override;
    juce::WebBrowserComponent::Options makeOptions();
    std::optional<juce::WebBrowserComponent::Resource> resource (const juce::String& url);
    void choose (const juce::String& title, const juce::File& start, const juce::String& pattern, int browseFlags,
                 std::function<void (const juce::File&)> then);

    GrooveRackProcessor& proc;
    std::unique_ptr<juce::FileChooser> chooser;
    juce::File lastDir;
    juce::WebBrowserComponent web;
    MidiDragStrip strip;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GrooveRackEditor)
};
