#pragma once

#include <lilv/lilv.h>
#include <string>
#include <vector>
#include <map>
#include <iostream>
#include <memory>

namespace aes67_deck {
namespace plugins {

struct PluginInfo {
    std::string uri;
    std::string name;
    std::string author;
};

class PluginInstance {
public:
    PluginInstance(LilvWorld* world, const LilvPlugin* plugin, double sample_rate);
    ~PluginInstance();

    bool instantiate();
    std::string get_uri() const { return lilv_node_as_string(lilv_plugin_get_uri(plugin_)); }
    
    // Audio thread methods
    void connect_audio_port(uint32_t port_index, float* buffer);
    void run(uint32_t nframes);
    
    // Control ports
    void set_control_value(uint32_t port_index, float value);
    void set_control_value_by_symbol(const std::string& symbol, float value);
    float get_control_value(uint32_t port_index) const;

    // Helpers
    int get_audio_input_port(int index) const; 
    int get_audio_output_port(int index) const;
    void print_ports() const;

private:
    LilvWorld* world_;
    const LilvPlugin* plugin_;
    double sample_rate_;
    LilvInstance* instance_ = nullptr;
    
    // Heap allocated control values to ensure stable pointers for lilv
    std::map<uint32_t, float*> control_values_;
    public: bool bypassed = true;
    
    std::vector<uint32_t> audio_inputs_;
    std::vector<uint32_t> audio_outputs_;
};

class Lv2Host {
public:
    Lv2Host();
    ~Lv2Host();

    void scan_plugins();
    std::vector<PluginInfo> get_all_plugins() const;

    std::unique_ptr<PluginInstance> instantiate_plugin(const std::string& uri, double sample_rate);

private:
    LilvWorld* world_ = nullptr;
};

} // namespace plugins
} // namespace aes67_deck
