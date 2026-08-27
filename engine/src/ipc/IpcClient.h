#pragma once
#include <string>
#include <thread>
#include <functional>
#include <jack/ringbuffer.h>
#include "json.hpp"

namespace aes67_deck {
namespace ipc {

class IpcClient {
public:
    IpcClient(const std::string& socket_path);
    ~IpcClient();

    void set_command_callback(std::function<void(const std::string&, int, int, float)> cb);
    void set_plugin_callback(std::function<void(const std::string&, int, int, const std::string&, float)> cb);
    // Plugin-chain structure commands (add/remove/reorder/replace/bulk
    // load) — these need richer payloads (URIs, param maps, arrays) than
    // set_plugin_callback's fixed (channel, index, paramId, value) shape,
    // so the full parsed message is handed through as-is.
    void set_plugin_manage_callback(std::function<void(const nlohmann::json&)> cb);
    // Transport / multitrack-record control (transport_play, transport_stop,
    // transport_locate, transport_set_loop, start_multitrack_record,
    // stop_multitrack_record) — payloads carry frame counts, channel arrays and
    // paths, so the whole parsed message is handed through as-is.
    void set_transport_callback(std::function<void(const nlohmann::json&)> cb);
    void send_metering(float l, float r);
    // Send an arbitrary already-serialised JSON line to the server (no
    // trailing newline needed). Same lock-free tx path as the metering frame.
    void send_json(const std::string& json_payload);
    void send_multichannel_metering(const std::string& json_payload);

private:
    void start();
    void stop();
    void run();

    std::string socket_path_;
    int sock_fd_;
    bool running_;
    std::thread thread_;
    std::function<void(const std::string&, int, int, float)> command_callback_;
    std::function<void(const std::string&, int, int, const std::string&, float)> plugin_callback_;
    std::function<void(const nlohmann::json&)> plugin_manage_callback_;
    std::function<void(const nlohmann::json&)> transport_callback_;
    jack_ringbuffer_t* tx_buffer_;
};

} // namespace ipc
} // namespace aes67_deck
