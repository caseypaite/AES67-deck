#include "JackClient.h"
#include <iostream>
#include <cstdlib>

namespace aes67_deck {
namespace audio {

JackClient::JackClient(const std::string& client_name) : client_name_(client_name) {
    jack_status_t status;
    client_ = jack_client_open(client_name_.c_str(), JackNullOption, &status);
    
    if (!client_) {
        std::cerr << "Failed to open JACK client. Status: " << status << std::endl;
        return;
    }

    jack_set_process_callback(client_, process_callback_wrapper, this);
    jack_on_shutdown(client_, shutdown_callback_wrapper, this);
}

JackClient::~JackClient() {
    if (client_) {
        jack_client_close(client_);
    }
}

bool JackClient::activate() {
    if (!client_) return false;
    return jack_activate(client_) == 0;
}

void JackClient::deactivate() {
    if (client_) {
        jack_deactivate(client_);
    }
}

void JackClient::register_input_port(const std::string& port_name) {
    if (!client_) return;
    jack_port_t* port = jack_port_register(client_, port_name.c_str(), JACK_DEFAULT_AUDIO_TYPE, JackPortIsInput, 0);
    if (port) {
        input_ports_.push_back(port);
    }
}

void JackClient::register_output_port(const std::string& port_name) {
    if (!client_) return;
    jack_port_t* port = jack_port_register(client_, port_name.c_str(), JACK_DEFAULT_AUDIO_TYPE, JackPortIsOutput, 0);
    if (port) {
        output_ports_.push_back(port);
    }
}

void JackClient::set_process_callback(std::function<void(jack_nframes_t)> callback) {
    process_callback_ = std::move(callback);
}

jack_nframes_t JackClient::get_sample_rate() const {
    if (!client_) return 48000;
    return jack_get_sample_rate(client_);
}

float* JackClient::get_buffer(jack_port_t* port, jack_nframes_t nframes) {
    return static_cast<float*>(jack_port_get_buffer(port, nframes));
}

int JackClient::process_callback_wrapper(jack_nframes_t nframes, void* arg) {
    auto* client = static_cast<JackClient*>(arg);
    if (client->process_callback_) {
        client->process_callback_(nframes);
    }
    return 0;
}

void JackClient::shutdown_callback_wrapper(void* arg) {
    std::cerr << "JACK server shutdown!" << std::endl;
    std::exit(1);
}

} // namespace audio
} // namespace aes67_deck
