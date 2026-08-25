#include "Lv2Host.h"

namespace aes67_deck {
namespace plugins {

// --- PluginInstance ---

PluginInstance::PluginInstance(LilvWorld* world, const LilvPlugin* plugin, double sample_rate)
    : world_(world), plugin_(plugin), sample_rate_(sample_rate) {}

PluginInstance::~PluginInstance() {
    if (instance_) {
        lilv_instance_free(instance_);
    }
    for (auto& pair : control_values_) {
        delete pair.second;
    }
}

bool PluginInstance::instantiate() {
    instance_ = lilv_plugin_instantiate(plugin_, sample_rate_, nullptr);
    if (!instance_) return false;

    LilvNode* audio_port = lilv_new_uri(world_, LILV_URI_AUDIO_PORT);
    LilvNode* control_port = lilv_new_uri(world_, LILV_URI_CONTROL_PORT);
    LilvNode* input_port = lilv_new_uri(world_, LILV_URI_INPUT_PORT);
    LilvNode* output_port = lilv_new_uri(world_, LILV_URI_OUTPUT_PORT);

    uint32_t num_ports = lilv_plugin_get_num_ports(plugin_);
    
    for (uint32_t i = 0; i < num_ports; ++i) {
        const LilvPort* port = lilv_plugin_get_port_by_index(plugin_, i);
        
        bool is_audio = lilv_port_is_a(plugin_, port, audio_port);
        bool is_control = lilv_port_is_a(plugin_, port, control_port);
        bool is_input = lilv_port_is_a(plugin_, port, input_port);
        bool is_output = lilv_port_is_a(plugin_, port, output_port);

        if (is_audio && is_input) audio_inputs_.push_back(i);
        if (is_audio && is_output) audio_outputs_.push_back(i);
        
        if (is_control) {
            float* val = new float(0.0f);
            
            // Get default value
            LilvNode* def = nullptr;
            LilvNode* min = nullptr;
            LilvNode* max = nullptr;
            lilv_port_get_range(plugin_, port, &def, &min, &max);
            
            if (def && lilv_node_is_float(def)) {
                *val = lilv_node_as_float(def);
            } else if (def && lilv_node_is_int(def)) {
                *val = static_cast<float>(lilv_node_as_int(def));
            }
            
            if (def) lilv_node_free(def);
            if (min) lilv_node_free(min);
            if (max) lilv_node_free(max);

            control_values_[i] = val;
            lilv_instance_connect_port(instance_, i, val);
        }
    }

    lilv_node_free(audio_port);
    lilv_node_free(control_port);
    lilv_node_free(input_port);
    lilv_node_free(output_port);

    lilv_instance_activate(instance_);
    return true;
}

void PluginInstance::connect_audio_port(uint32_t port_index, float* buffer) {
    if (instance_) lilv_instance_connect_port(instance_, port_index, buffer);
}

void PluginInstance::run(uint32_t nframes) {
    if (instance_) lilv_instance_run(instance_, nframes);
}

void PluginInstance::set_control_value_by_symbol(const std::string& symbol, float value) {
    LilvNode* sym_node = lilv_new_string(world_, symbol.c_str());
    const LilvPort* port = lilv_plugin_get_port_by_symbol(plugin_, sym_node);
    lilv_node_free(sym_node);
    if (port) {
        uint32_t idx = lilv_port_get_index(plugin_, port);
        set_control_value(idx, value);
    }
}

void PluginInstance::set_control_value(uint32_t port_index, float value) {
    if (control_values_.find(port_index) != control_values_.end()) {
        *(control_values_[port_index]) = value;
    }
}

float PluginInstance::get_control_value(uint32_t port_index) const {
    if (control_values_.find(port_index) != control_values_.end()) {
        return *(control_values_.at(port_index));
    }
    return 0.0f;
}

int PluginInstance::get_audio_input_port(int index) const {
    if (index >= 0 && index < static_cast<int>(audio_inputs_.size())) return audio_inputs_[index];
    return -1;
}

int PluginInstance::get_audio_output_port(int index) const {
    if (index >= 0 && index < static_cast<int>(audio_outputs_.size())) return audio_outputs_[index];
    return -1;
}

void PluginInstance::print_ports() const {
    std::cout << "Plugin has " << audio_inputs_.size() << " audio inputs and " 
              << audio_outputs_.size() << " audio outputs." << std::endl;
}

// --- Lv2Host ---

Lv2Host::Lv2Host() {
    world_ = lilv_world_new();
    if (world_) {
        lilv_world_load_all(world_);
    }
}

Lv2Host::~Lv2Host() {
    if (world_) {
        lilv_world_free(world_);
    }
}

void Lv2Host::scan_plugins() {
    if (!world_) return;
    std::cout << "LV2 plugins loaded." << std::endl;
}

std::vector<PluginInfo> Lv2Host::get_all_plugins() const {
    std::vector<PluginInfo> plugins;
    if (!world_) return plugins;

    const LilvPlugins* lilv_plugins = lilv_world_get_all_plugins(world_);
    LILV_FOREACH(plugins, i, lilv_plugins) {
        const LilvPlugin* p = lilv_plugins_get(lilv_plugins, i);
        
        const LilvNode* uri_node = lilv_plugin_get_uri(p);
        LilvNode* name_node = lilv_plugin_get_name(p);
        LilvNode* author_node = lilv_plugin_get_author_name(p);

        PluginInfo info;
        if (uri_node) info.uri = lilv_node_as_string(uri_node);
        if (name_node) info.name = lilv_node_as_string(name_node);
        if (author_node) info.author = lilv_node_as_string(author_node);

        if (name_node) lilv_node_free(name_node);
        if (author_node) lilv_node_free(author_node);
        
        plugins.push_back(info);
    }
    return plugins;
}

std::unique_ptr<PluginInstance> Lv2Host::instantiate_plugin(const std::string& uri, double sample_rate) {
    if (!world_) return nullptr;
    
    LilvNode* uri_node = lilv_new_uri(world_, uri.c_str());
    if (!uri_node) return nullptr;

    const LilvPlugins* plugins = lilv_world_get_all_plugins(world_);
    const LilvPlugin* plugin = lilv_plugins_get_by_uri(plugins, uri_node);
    
    lilv_node_free(uri_node);

    if (!plugin) {
        std::cerr << "Plugin not found: " << uri << std::endl;
        return nullptr;
    }

    auto instance = std::make_unique<PluginInstance>(world_, plugin, sample_rate);
    if (!instance->instantiate()) {
        return nullptr;
    }
    
    return instance;
}

} // namespace plugins
} // namespace aes67_deck
