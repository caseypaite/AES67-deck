#pragma once

#include <lilv/lilv.h>
#include <lv2/atom/atom.h>
#include <string>
#include <string_view>
#include <vector>
#include <map>
#include <atomic>
#include <iostream>
#include <memory>
#include <cstdint>
#include <cstring>

namespace aes67_deck {
namespace plugins {

// One control input port's metadata, enough for the UI to render a generic
// knob for any plugin without needing a hand-built skin: symbol is what
// PluginInstance::set_control_value_by_symbol expects.
struct PluginControlPortInfo {
    std::string symbol;
    std::string name;
    float min = 0.0f;
    float max = 1.0f;
    float default_value = 0.0f;
};

struct PluginInfo {
    std::string uri;
    std::string name;
    std::string author;
    // True if this plugin declares an lv2:latency-designated output
    // control port, i.e. it reports algorithmic delay to hosts — the UI
    // groups these as "Studio" and everything else as "Live" (0 latency).
    // This is a *static* check only (port metadata, no instantiate/run):
    // actually running an arbitrary third-party plugin during a
    // system-wide scan isn't safe without out-of-process sandboxing — a
    // scan of the real system catalog segfaulted inside
    // lsp-plugins-lv2.so before this was pulled back to static-only.
    bool reports_latency = false;
    std::vector<PluginControlPortInfo> control_ports;
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
    
    // Control ports. set_control_value_by_symbol() is RT-safe — the
    // symbol->port-index map is built once in instantiate() and read-only
    // after, so this is a map lookup plus a float store, no lilv calls, no
    // allocation. Safe to call from the audio thread (via the plugin command
    // ring) as well as the IPC thread.
    void set_control_value(uint32_t port_index, float value);
    // RT thread calls this with a char[] from the plugin command ring — takes
    // string_view so no std::string is constructed on the audio thread.
    void set_control_value_by_symbol(std::string_view symbol, float value);
    float get_control_value(uint32_t port_index) const;

    // Helpers
    int get_audio_input_port(int index) const; 
    int get_audio_output_port(int index) const;
    void print_ports() const;

    // Written from the IPC thread (add/load seeding) and, via the plugin
    // command ring, applied on the audio thread; read every block by the
    // audio thread's insert-chain loop.
    std::atomic<bool> bypassed{true};

private:
    LilvWorld* world_;
    const LilvPlugin* plugin_;
    double sample_rate_;
    LilvInstance* instance_ = nullptr;

    // Heap allocated control values to ensure stable pointers for lilv
    std::map<uint32_t, float*> control_values_;
    // symbol -> control-port index, built in instantiate(), read-only after.
    std::map<std::string, uint32_t, std::less<>> control_index_by_symbol_;  // std::less<> → heterogeneous find()
    
    std::vector<uint32_t> audio_inputs_;
    std::vector<uint32_t> audio_outputs_;

    // Dummy backing buffer for Atom ports (e.g. LSP in_ui / out_ui) and any
    // other port types the engine doesn't natively handle. These ports must
    // still be connected to a valid memory region or the plugin dereferences
    // null during run() — 4 KB is large enough for a minimal LV2_Atom_Sequence
    // header plus a few events, and the buffer is pre-zeroed so the Sequence's
    // atom.size field reads 0 (= empty sequence) on first use.
    static constexpr size_t DUMMY_ATOM_BUF_SIZE = 4096;
    uint8_t dummy_atom_buf_[DUMMY_ATOM_BUF_SIZE] = {};
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
