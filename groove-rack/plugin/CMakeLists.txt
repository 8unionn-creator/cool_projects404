cmake_minimum_required(VERSION 3.22)
project(GrooveRack VERSION 0.2.3)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Oldest macOS the plugin runs on")

# Use a local JUCE checkout with -DJUCE_DIR=/path/to/JUCE, or let CMake download it.
if(DEFINED JUCE_DIR)
    add_subdirectory(${JUCE_DIR} JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.15
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

set(GR_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND GR_FORMATS AU)
endif()

juce_add_plugin(GrooveRack
    COMPANY_NAME "cool_projects404"
    BUNDLE_ID "com.coolprojects404.grooverack"
    PLUGIN_MANUFACTURER_CODE Cp44
    PLUGIN_CODE Grvr
    FORMATS ${GR_FORMATS}
    PRODUCT_NAME "Groove Rack"
    DESCRIPTION "Drum and bass groove maker"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    VST3_CATEGORIES Instrument Drum
    AU_MAIN_TYPE kAudioUnitType_MusicDevice)

# The web UI (the same files as the browser version), the rendered kit and the default beat
file(GLOB GR_KIT "${CMAKE_CURRENT_SOURCE_DIR}/kit/*.wav")
juce_add_binary_data(GrooveRackData SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/../index.html
    ${CMAKE_CURRENT_SOURCE_DIR}/../engine.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../presets.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../groove.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../app.js
    ${CMAKE_CURRENT_SOURCE_DIR}/kit/default-project.json
    ${GR_KIT})

target_sources(GrooveRack PRIVATE
    Source/Engine.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(GrooveRack PUBLIC
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_USE_MP3AUDIOFORMAT=1)
if(WIN32)
    target_compile_definitions(GrooveRack PUBLIC JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
endif()

target_link_libraries(GrooveRack
    PRIVATE
        GrooveRackData
        juce::juce_audio_utils
        juce::juce_audio_formats
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Headless engine test: cmake -DGR_TESTS=ON, then run GrooveRackEngineTest
option(GR_TESTS "Build the engine test" OFF)
if(GR_TESTS)
    juce_add_console_app(GrooveRackEngineTest PRODUCT_NAME "GrooveRackEngineTest")
    target_sources(GrooveRackEngineTest PRIVATE tests/EngineTest.cpp Source/Engine.cpp)
    target_compile_definitions(GrooveRackEngineTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_USE_MP3AUDIOFORMAT=1)
    target_link_libraries(GrooveRackEngineTest PRIVATE GrooveRackData juce::juce_audio_formats juce::juce_audio_basics
        PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
endif()
