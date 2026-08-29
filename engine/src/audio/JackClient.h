#pragma once

#include <jack/jack.h>
#include <atomic>
#include <string>
#include <vector>
#include <functional>
#include <memory>
#include <iostream>

namespace aes67_deck {
namespace audio {

class JackClient {
public:
    JackClient(const std::string& client_name);
    ~JackClient();

    bool activate();
    void deactivate();

    void register_input_port(const std::string& port_name);
    void register_output_port(const std::string& port_name);
    // MIDI output port (JACK_DEFAULT_MIDI_TYPE) — kept separate from the audio
    // output list so positional audio-port indices stay stable. Used for MTC.
    void register_midi_output_port(const std::string& port_name);

    void set_process_callback(std::function<void(jack_nframes_t)> callback);

    jack_client_t* get_client() const { return client_; }
    jack_nframes_t get_sample_rate() const;

    // Total JACK xruns since start. Bumped from JACK's xrun callback (a
    // non-RT notification thread). Echoed on the metering frame so the
    // operator / a soak test can see live dropouts, e.g. the burst that has
    // been suspected of distorting the head of multitrack takes.
    uint32_t get_xrun_count() const { return xruns_.load(std::memory_order_relaxed); }
    
    // Helper to get buffer for a port
    float* get_buffer(jack_port_t* port, jack_nframes_t nframes);
    
    // Access registered ports
    const std::vector<jack_port_t*>& get_input_ports() const { return input_ports_; }
    const std::vector<jack_port_t*>& get_output_ports() const { return output_ports_; }
    const std::vector<jack_port_t*>& get_midi_output_ports() const { return midi_output_ports_; }

private:
    static int process_callback_wrapper(jack_nframes_t nframes, void* arg);
    static void shutdown_callback_wrapper(void* arg);
    static int xrun_callback_wrapper(void* arg);

    jack_client_t* client_ = nullptr;
    std::string client_name_;
    std::atomic<uint32_t> xruns_{0};
    
    std::vector<jack_port_t*> input_ports_;
    std::vector<jack_port_t*> output_ports_;
    std::vector<jack_port_t*> midi_output_ports_;
    
    std::function<void(jack_nframes_t)> process_callback_;
};

} // namespace audio
} // namespace aes67_deck
