#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

/*  The plugin window: Spin Room's web page, bundled inside the plugin, in a web view.
    The page talks to the plugin through native functions (spinroom_*) and hears about
    new takes and recording status through events.                                     */
class SpinRoomEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit SpinRoomEditor (SpinRoomProcessor&);
    ~SpinRoomEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    juce::WebBrowserComponent::Options makeOptions();
    std::optional<juce::WebBrowserComponent::Resource> getResource (const juce::String& path);
    juce::var statusVar() const;

    SpinRoomProcessor& proc;

    struct PendingSave
    {
        juce::File file;
        std::unique_ptr<juce::FileOutputStream> out;
    };
    std::map<juce::String, PendingSave> saves;
    juce::String lastStatusJson;

    juce::WebBrowserComponent web { makeOptions() };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SpinRoomEditor)
};
