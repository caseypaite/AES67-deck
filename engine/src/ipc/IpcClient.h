#pragma once
#include <string>
#include <thread>
#include <functional>
#include <mutex>
#include <deque>
#include <atomic>
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
    // Send an already-serialised JSON line to the server (no trailing newline
    // needed) from a NON-RT thread — goes through a mutex-guarded queue, not
    // the SPSC metering ring, so it is safe to call concurrently with the
    // audio thread's send_multichannel_metering().
    void send_json(const std::string& json_payload);
    void send_json_async(const std::string& json_payload);
    // Audio-thread only. Lock-free SPSC ring — this is the single producer.
    void send_multichannel_metering(const std::string& json_payload);

    // Start the worker thread. Call this AFTER installing every callback — the
    // worker reads command_callback_ / transport_callback_ / … with no
    // synchronisation, so starting it from the constructor (before main() sets
    // them) is a data race on those std::function objects.
    void start();

private:
    void stop();
    void run();

    std::string socket_path_;
    int sock_fd_;
    std::atomic<bool> running_;
    std::thread thread_;
    std::function<void(const std::string&, int, int, float)> command_callback_;
    std::function<void(const std::string&, int, int, const std::string&, float)> plugin_callback_;
    std::function<void(const nlohmann::json&)> plugin_manage_callback_;
    std::function<void(const nlohmann::json&)> transport_callback_;
    jack_ringbuffer_t* tx_buffer_;            // RT audio thread -> IPC thread (SPSC)
    std::mutex async_tx_mutex_;               // guards async_tx_
    std::deque<std::string> async_tx_;        // non-RT producers -> IPC thread
};

} // namespace ipc
} // namespace aes67_deck
