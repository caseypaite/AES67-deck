#pragma once

#include <jack/jack.h>
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

    void set_process_callback(std::function<void(jack_nframes_t)> callback);

    jack_client_t* get_client() const { return client_; }
    jack_nframes_t get_sample_rate() const;
    
    // Helper to get buffer for a port
    float* get_buffer(jack_port_t* port, jack_nframes_t nframes);
    
    // Access registered ports
    const std::vector<jack_port_t*>& get_input_ports() const { return input_ports_; }
    const std::vector<jack_port_t*>& get_output_ports() const { return output_ports_; }

private:
    static int process_callback_wrapper(jack_nframes_t nframes, void* arg);
    static void shutdown_callback_wrapper(void* arg);

    jack_client_t* client_ = nullptr;
    std::string client_name_;
    
    std::vector<jack_port_t*> input_ports_;
    std::vector<jack_port_t*> output_ports_;
    
    std::function<void(jack_nframes_t)> process_callback_;
};

} // namespace audio
} // namespace aes67_deck
