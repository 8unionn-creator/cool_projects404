#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

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

    LiftoffProcessor& proc;
    std::map<juce::String, float> sent;   // the values the page has, so only host changes are sent back
    int lastDrops = -1;
    juce::WebBrowserComponent web;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiftoffEditor)
};
