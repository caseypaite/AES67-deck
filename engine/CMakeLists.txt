cmake_minimum_required(VERSION 3.10)
project(aes67_deck_engine)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -ffast-math")
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0 -fsanitize=address")
add_compile_options(-Wall -Wextra)

# Opt-in sanitizer build for concurrency / memory verification, e.g.
#   cmake -B build-tsan -DSANITIZE=thread   (then run with
#   TSAN_OPTIONS=suppressions=engine/tsan.supp — jack_ringbuffer is a
#   correct lock-free SPSC queue that TSan cannot see the ordering of).
# Values: thread | address | undefined. Overrides the Debug ASan default.
set(SANITIZE "" CACHE STRING "Sanitizer: thread | address | undefined")
if(SANITIZE)
    set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")
    add_compile_options(-fsanitize=${SANITIZE} -g -O1 -fno-omit-frame-pointer)
    add_link_options(-fsanitize=${SANITIZE})
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(LILV REQUIRED lilv-0)
pkg_check_modules(SNDFILE REQUIRED sndfile)
pkg_check_modules(JACK REQUIRED jack)
pkg_check_modules(WAVPACK REQUIRED wavpack)

include_directories(
    src
    ${LILV_INCLUDE_DIRS}
    ${SNDFILE_INCLUDE_DIRS}
    ${JACK_INCLUDE_DIRS}
    ${WAVPACK_INCLUDE_DIRS}
)

add_executable(aes67_deck_engine
    src/main.cpp
    src/audio/JackClient.cpp
    src/plugins/Lv2Host.cpp
    src/ipc/IpcClient.cpp
    src/recorder/DiskWriter.cpp
    src/recorder/MultitrackRecorder.cpp
    src/recorder/WavpackWriter.cpp
    src/playback/TimelinePlayer.cpp
    src/timecode/Timecode.cpp
)

target_link_libraries(aes67_deck_engine
    ${LILV_LIBRARIES}
    ${SNDFILE_LIBRARIES}
    ${JACK_LIBRARIES}
    ${WAVPACK_LIBRARIES}
    pthread
)
