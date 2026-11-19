cmake_minimum_required(VERSION 3.22)
project(Liftoff VERSION 0.5.0)

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

set(LF_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND LF_FORMATS AU)
endif()

juce_add_plugin(Liftoff
    COMPANY_NAME "cool_projects404"
    BUNDLE_ID "com.coolprojects404.liftoff"
    PLUGIN_MANUFACTURER_CODE Cp44
    PLUGIN_CODE Lftf
    FORMATS ${LF_FORMATS}
    PRODUCT_NAME "Liftoff"
    DESCRIPTION "Turn any sample into a riser: rise, backverb, tremolo, chorus"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    VST3_CATEGORIES Fx Reverb
    AU_MAIN_TYPE kAudioUnitType_MusicEffect)

# the web UI: the same files as the browser version (params.js also defines the plugin's parameters)
juce_add_binary_data(LiftoffData SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/../index.html
    ${CMAKE_CURRENT_SOURCE_DIR}/../params.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../dsp.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../transition.js
    ${CMAKE_CURRENT_SOURCE_DIR}/../app.js)

target_sources(Liftoff PRIVATE
    Source/Core.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

# The DSP core must do exactly the arithmetic dsp.js does: no fused multiply-adds (Clang, e.g. on Apple Silicon, fuses them
# by default), or a tremolo step that falls exactly on a sample can flip one sample early and the two versions drift apart.
if(NOT MSVC)
    set_source_files_properties(Source/Core.cpp PROPERTIES COMPILE_OPTIONS "-ffp-contract=off")
endif()

target_compile_definitions(Liftoff PUBLIC
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_VST3_EMULATE_MIDI_CC_WITH_PARAMETERS=0)   # MIDI only starts builds: no 2000 "MIDI CC" parameters in the DAW's list
if(WIN32)
    target_compile_definitions(Liftoff PUBLIC JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
endif()

target_link_libraries(Liftoff
    PRIVATE
        LiftoffData
        juce::juce_audio_utils
        juce::juce_audio_formats
        juce::juce_dsp
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# Headless engine test: cmake -DLF_TESTS=ON, then run LiftoffEngineTest
option(LF_TESTS "Build the engine test" OFF)
if(LF_TESTS)
    juce_add_console_app(LiftoffEngineTest PRODUCT_NAME "LiftoffEngineTest")
    target_sources(LiftoffEngineTest PRIVATE tests/EngineTest.cpp Source/Core.cpp)
    target_compile_definitions(LiftoffEngineTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
    target_link_libraries(LiftoffEngineTest PRIVATE juce::juce_dsp juce::juce_audio_basics juce::juce_events
        PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

    # loads the built VST3 like a DAW: LiftoffHostTest path/to/Liftoff.vst3
    juce_add_console_app(LiftoffHostTest PRODUCT_NAME "LiftoffHostTest")
    target_sources(LiftoffHostTest PRIVATE tests/HostTest.cpp)
    target_compile_definitions(LiftoffHostTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(LiftoffHostTest PRIVATE juce::juce_audio_processors
        PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
endif()
