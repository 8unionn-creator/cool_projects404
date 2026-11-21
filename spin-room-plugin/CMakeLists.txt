cmake_minimum_required(VERSION 3.22)
project(SpinRoom VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Oldest macOS the plugin runs on")

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

set(SR_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND SR_FORMATS AU)
endif()

juce_add_plugin(SpinRoom
    COMPANY_NAME "cool_projects404"
    BUNDLE_ID "com.coolprojects404.spinroom"
    PLUGIN_MANUFACTURER_CODE Cp44
    PLUGIN_CODE Spnr
    FORMATS ${SR_FORMATS}
    PRODUCT_NAME "Spin Room"
    DESCRIPTION "Catches your beat as it plays and turns it into a video"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Spin Room listens to the audio input you choose so it can catch your beat."
    VST3_CATEGORIES Fx Tools
    AU_MAIN_TYPE kAudioUnitType_Effect)

# Spin Room's web page (the same file as the browser version) is built into the plugin.
juce_add_binary_data(SpinRoomWeb
    HEADER_NAME SpinRoomWebData.h
    NAMESPACE SpinRoomWebData
    SOURCES
        ${CMAKE_CURRENT_SOURCE_DIR}/../spin-room/index.html
        ${CMAKE_CURRENT_SOURCE_DIR}/../spin-room/vendor/mp4-muxer.js)

target_sources(SpinRoom PRIVATE
    Source/TakeRecorder.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(SpinRoom PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)
if(WIN32)
    target_compile_definitions(SpinRoom PUBLIC JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
endif()

target_link_libraries(SpinRoom
    PRIVATE
        SpinRoomWeb
        juce::juce_audio_utils
        juce::juce_audio_formats
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

option(SR_TESTS "Build the tests" OFF)
if(SR_TESTS)
    # the capture engine on its own: a fake transport, checked takes
    juce_add_console_app(SpinRoomCaptureTest PRODUCT_NAME "SpinRoomCaptureTest")
    target_sources(SpinRoomCaptureTest PRIVATE tests/CaptureTest.cpp Source/TakeRecorder.cpp)
    target_compile_definitions(SpinRoomCaptureTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
    target_link_libraries(SpinRoomCaptureTest PRIVATE juce::juce_audio_formats juce::juce_events
        PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

    # loads the built VST3 like a DAW: SpinRoomHostTest "path/to/Spin Room.vst3"
    juce_add_console_app(SpinRoomHostTest PRODUCT_NAME "SpinRoomHostTest")
    target_sources(SpinRoomHostTest PRIVATE tests/HostTest.cpp)
    target_compile_definitions(SpinRoomHostTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(SpinRoomHostTest PRIVATE juce::juce_audio_processors juce::juce_audio_formats
        PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
endif()
