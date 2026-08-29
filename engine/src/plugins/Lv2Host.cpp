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

    LilvNode* audio_port_t   = lilv_new_uri(world_, LILV_URI_AUDIO_PORT);
    LilvNode* control_port_t = lilv_new_uri(world_, LILV_URI_CONTROL_PORT);
    LilvNode* input_port_t   = lilv_new_uri(world_, LILV_URI_INPUT_PORT);
    LilvNode* output_port_t  = lilv_new_uri(world_, LILV_URI_OUTPUT_PORT);
    // Atom port type URI — needed to detect LSP UI ports (in_ui / out_ui)
    // and any other atom:AtomPort that the engine doesn't otherwise process.
    LilvNode* atom_port_t    = lilv_new_uri(world_, "http://lv2plug.in/ns/ext/atom#AtomPort");

    // Pre-initialise the dummy buffer as an empty LV2_Atom_Sequence so that
    // plugins reading an input Atom port see a well-formed empty sequence
    // rather than raw zeroes (some plugins assert atom.type != 0).
    // Using raw byte offsets to avoid a direct dependency on lv2/atom/util.h
    // beyond what the header already pulls in via lv2/atom/atom.h.
    {
        LV2_Atom_Sequence* seq = reinterpret_cast<LV2_Atom_Sequence*>(dummy_atom_buf_);
        seq->atom.size = sizeof(LV2_Atom_Sequence_Body);
        seq->atom.type = 0; // Will be filled by host in a real implementation; 0 is safe here.
        seq->body.unit = 0;
        seq->body.pad  = 0;
    }

    uint32_t num_ports = lilv_plugin_get_num_ports(plugin_);
    
    for (uint32_t i = 0; i < num_ports; ++i) {
        const LilvPort* port = lilv_plugin_get_port_by_index(plugin_, i);
        
        bool is_audio   = lilv_port_is_a(plugin_, port, audio_port_t);
        bool is_control = lilv_port_is_a(plugin_, port, control_port_t);
        bool is_atom    = lilv_port_is_a(plugin_, port, atom_port_t);
        bool is_input   = lilv_port_is_a(plugin_, port, input_port_t);
        bool is_output  = lilv_port_is_a(plugin_, port, output_port_t);

        if (is_audio && is_input)  audio_inputs_.push_back(i);
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
            const LilvNode* sym = lilv_port_get_symbol(plugin_, port);
            if (sym) control_index_by_symbol_[lilv_node_as_string(sym)] = i;
            lilv_instance_connect_port(instance_, i, val);
        } else if (is_atom || (!is_audio && !is_control)) {
            // Atom port or any other port type the engine doesn't handle
            // (e.g. CV ports, MIDI ports). Connect to the dummy buffer so
            // the plugin never dereferences a null pointer during run().
            // Output atom ports that attempt to write events will simply
            // overwrite the dummy buffer, which is harmless.
            lilv_instance_connect_port(instance_, i, dummy_atom_buf_);
        }
        // Audio ports are connected per-callback in main.cpp; leave them
        // unconnected here — they will be wired up before the first run().
    }

    lilv_node_free(audio_port_t);
    lilv_node_free(control_port_t);
    lilv_node_free(input_port_t);
    lilv_node_free(output_port_t);
    lilv_node_free(atom_port_t);

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
    // RT-safe: resolved against the map built in instantiate(), no lilv calls,
    // no allocation. An unknown symbol is a harmless no-op.
    auto it = control_index_by_symbol_.find(symbol);
    if (it != control_index_by_symbol_.end()) {
        set_control_value(it->second, value);
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

    LilvNode* control_port_t = lilv_new_uri(world_, LILV_URI_CONTROL_PORT);
    LilvNode* input_port_t = lilv_new_uri(world_, LILV_URI_INPUT_PORT);
    LilvNode* output_port_t = lilv_new_uri(world_, LILV_URI_OUTPUT_PORT);
    // lv2core#designation on an output control port marks it as reporting
    // something specific — lv2core#latency is the standard convention for
    // "this port reports algorithmic delay". Not worth pulling in the full
    // lv2core.h just for two URI strings. This is checked as static port
    // metadata only — no instantiate/run — see PluginInfo::reports_latency
    // for why: actually running arbitrary third-party plugins during a
    // system-wide scan isn't safe without out-of-process sandboxing.
    LilvNode* designation_pred = lilv_new_uri(world_, "http://lv2plug.in/ns/lv2core#designation");
    static const std::string LATENCY_DESIGNATION = "http://lv2plug.in/ns/lv2core#latency";

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

        uint32_t num_ports = lilv_plugin_get_num_ports(p);
        for (uint32_t pi = 0; pi < num_ports; ++pi) {
            const LilvPort* port = lilv_plugin_get_port_by_index(p, pi);
            bool is_control = lilv_port_is_a(p, port, control_port_t);
            bool is_input = lilv_port_is_a(p, port, input_port_t);
            bool is_output = lilv_port_is_a(p, port, output_port_t);

            if (is_control && is_output && !info.reports_latency) {
                LilvNodes* designations = lilv_port_get_value(p, port, designation_pred);
                if (designations) {
                    LILV_FOREACH(nodes, di, designations) {
                        const LilvNode* d = lilv_nodes_get(designations, di);
                        if (d && lilv_node_is_uri(d) && LATENCY_DESIGNATION == lilv_node_as_uri(d)) {
                            info.reports_latency = true;
                        }
                    }
                    lilv_nodes_free(designations);
                }
            }

            if (is_control && is_input) {
                PluginControlPortInfo cp;
                // lilv_port_get_symbol returns a node owned by the plugin —
                // must not be freed here.
                const LilvNode* sym = lilv_port_get_symbol(p, port);
                if (sym) cp.symbol = lilv_node_as_string(sym);

                LilvNode* pname = lilv_port_get_name(p, port);
                if (pname) { cp.name = lilv_node_as_string(pname); lilv_node_free(pname); }

                LilvNode* def = nullptr;
                LilvNode* min = nullptr;
                LilvNode* max = nullptr;
                lilv_port_get_range(p, port, &def, &min, &max);
                if (def && lilv_node_is_float(def)) cp.default_value = lilv_node_as_float(def);
                else if (def && lilv_node_is_int(def)) cp.default_value = static_cast<float>(lilv_node_as_int(def));
                if (min && lilv_node_is_float(min)) cp.min = lilv_node_as_float(min);
                else if (min && lilv_node_is_int(min)) cp.min = static_cast<float>(lilv_node_as_int(min));
                if (max && lilv_node_is_float(max)) cp.max = lilv_node_as_float(max);
                else if (max && lilv_node_is_int(max)) cp.max = static_cast<float>(lilv_node_as_int(max));
                if (def) lilv_node_free(def);
                if (min) lilv_node_free(min);
                if (max) lilv_node_free(max);

                if (!cp.symbol.empty()) info.control_ports.push_back(cp);
            }
        }

        if (name_node) lilv_node_free(name_node);
        if (author_node) lilv_node_free(author_node);

        plugins.push_back(info);
    }

    lilv_node_free(control_port_t);
    lilv_node_free(input_port_t);
    lilv_node_free(output_port_t);
    lilv_node_free(designation_pred);

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
