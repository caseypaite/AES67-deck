#include "IpcClient.h"
#include <iostream>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <cerrno>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>
#include "json.hpp"

namespace aes67_deck {
namespace ipc {

IpcClient::IpcClient(const std::string& socket_path) : socket_path_(socket_path), sock_fd_(-1), running_(false) {
    // 4MB: mostly headroom for the one-time plugin catalog dump (hundreds
    // of LV2 plugins, each with several control ports of metadata) — the
    // regular per-cycle metering messages are tiny by comparison.
    tx_buffer_ = jack_ringbuffer_create(1024 * 1024 * 4);
    start();
}

IpcClient::~IpcClient() {
    stop();
    if (tx_buffer_) {
        jack_ringbuffer_free(tx_buffer_);
    }
}

void IpcClient::set_command_callback(std::function<void(const std::string&, int, int, float)> cb) {
    command_callback_ = cb;
}
void IpcClient::set_plugin_manage_callback(std::function<void(const nlohmann::json&)> cb) {
    plugin_manage_callback_ = cb;
}
void IpcClient::set_plugin_callback(std::function<void(const std::string&, int, int, const std::string&, float)> cb) {
    plugin_callback_ = cb;
}
void IpcClient::set_transport_callback(std::function<void(const nlohmann::json&)> cb) {
    transport_callback_ = cb;
}

void IpcClient::send_json(const std::string& json_payload) {
    send_multichannel_metering(json_payload);
}

void IpcClient::send_metering(float l, float r) {
    // Legacy fallback, you can update this to full multichannel metering string
    std::string msg = "{\"type\":\"metering\",\"channels\":{\"100\":{\"l\":" + std::to_string(l) + ",\"r\":" + std::to_string(r) + "}}}\n";
    if (jack_ringbuffer_write_space(tx_buffer_) >= msg.length()) {
        jack_ringbuffer_write(tx_buffer_, msg.c_str(), msg.length());
    }
}

void IpcClient::send_multichannel_metering(const std::string& json_payload) {
    std::string msg = json_payload + "\n";
    if (jack_ringbuffer_write_space(tx_buffer_) >= msg.length()) {
        jack_ringbuffer_write(tx_buffer_, msg.c_str(), msg.length());
    }
}

void IpcClient::start() {
    running_ = true;
    thread_ = std::thread(&IpcClient::run, this);
}

void IpcClient::stop() {
    running_ = false;
    if (thread_.joinable()) {
        thread_.join();
    }
    if (sock_fd_ >= 0) {
        close(sock_fd_);
        sock_fd_ = -1;
    }
}

void IpcClient::run() {
    std::vector<char> tx_scratch(64 * 1024);
    // Bytes pulled from the lock-free ring buffer but not yet fully written to
    // the socket. A non-blocking send() can accept a partial write (or none);
    // the leftover has to survive to the next loop or the JSON stream tears.
    std::string tx_pending;
    using json = nlohmann::json;

    while (running_) {
        if (sock_fd_ < 0) {
            sock_fd_ = socket(AF_UNIX, SOCK_STREAM, 0);
            if (sock_fd_ < 0) {
                std::this_thread::sleep_for(std::chrono::seconds(1));
                continue;
            }

            struct sockaddr_un addr;
            memset(&addr, 0, sizeof(addr));
            addr.sun_family = AF_UNIX;
            strncpy(addr.sun_path, socket_path_.c_str(), sizeof(addr.sun_path) - 1);

            if (connect(sock_fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
                close(sock_fd_);
                sock_fd_ = -1;
                std::this_thread::sleep_for(std::chrono::seconds(1));
                continue;
            }

            std::cout << "C++ IPC connected to " << socket_path_ << std::endl;
            
            // Set non-blocking
            int flags = fcntl(sock_fd_, F_GETFL, 0);
            fcntl(sock_fd_, F_SETFL, flags | O_NONBLOCK);
        }

        // Read incoming commands
        char rx_buf[1024];
        int n = recv(sock_fd_, rx_buf, sizeof(rx_buf) - 1, 0);
        if (n > 0) {
            rx_buf[n] = '\0';
            std::string payload(rx_buf);
            
            std::vector<std::string> lines;
            size_t pos = 0;
            while ((pos = payload.find('\n')) != std::string::npos) {
                lines.push_back(payload.substr(0, pos));
                payload.erase(0, pos + 1);
            }
            if (!payload.empty()) lines.push_back(payload);

            for (const auto& line : lines) {
                if (line.empty()) continue;
                try {
                    auto j = json::parse(line);
                    std::string type = j.value("type", "");
                    
                    if (type == "start_record") {
                        if (command_callback_) command_callback_("start_record", 0, -1, 0.0f);
                    } else if (type == "stop_record") {
                        if (command_callback_) command_callback_("stop_record", 0, -1, 0.0f);
                    } else if (type == "lufs_reset") {
                        if (command_callback_) command_callback_("lufs_reset", 0, -1, 0.0f);
                    } else if (type == "set_plugin_param" || type == "set_plugin_bypass") {
                        int channel = j.value("channel", -1);
                        int p_idx = j.value("pluginIndex", -1);
                        if (channel != -1 && p_idx != -1) {
                            float val = j.value("value", 0.0f);
                            std::string p_id = j.value("paramId", "");
                            if (plugin_callback_) plugin_callback_(type, channel, p_idx, p_id, val);
                        }
                    } else if (type == "fx_focus") {
                        // Which plugin editor the UI has open — drives the
                        // per-plugin in/out metering. pluginIndex -1 == none.
                        int channel = j.value("channel", -1);
                        int p_idx = j.value("pluginIndex", -1);
                        if (command_callback_) command_callback_("fx_focus", channel, p_idx, 0.0f);
                    } else if (type == "add_plugin" || type == "remove_plugin" || type == "reorder_plugin" ||
                               type == "replace_plugin" || type == "load_rack") {
                        // Richer payloads (URIs, param maps, arrays) than the
                        // fixed-shape callbacks above handle — hand the whole
                        // parsed message through.
                        if (plugin_manage_callback_) plugin_manage_callback_(j);
                    } else if (type == "transport_play" || type == "transport_stop" ||
                               type == "transport_locate" || type == "transport_set_loop" ||
                               type == "transport_set_punch" ||
                               type == "bounce_start" || type == "bounce_abort" ||
                               type == "start_multitrack_record" || type == "stop_multitrack_record" ||
                               type == "set_timeline" || type == "set_monitor_input_mask") {
                        if (transport_callback_) transport_callback_(j);
                    } else {
                        int channel = j.value("channel", -1);
                        if (channel != -1) {
                            float val = j.value("value", 0.0f);
                            int bus_id = j.value("busId", -1);
                            if (command_callback_) command_callback_(type, channel, bus_id, val);
                        }
                    }
                } catch (...) {
                    // Ignore parse errors
                }
            }
        } else if (n == 0) {
            close(sock_fd_);
            sock_fd_ = -1;
        }

        // ── Drain the lock-free ring buffer into the pending send buffer ──
        size_t avail = jack_ringbuffer_read_space(tx_buffer_);
        while (avail > 0) {
            size_t chunk = std::min(avail, tx_scratch.size());
            jack_ringbuffer_read(tx_buffer_, tx_scratch.data(), chunk);
            tx_pending.append(tx_scratch.data(), chunk);
            avail -= chunk;
        }

        // If the server has stalled, cap the backlog by dropping whole oldest
        // lines rather than growing without bound — telemetry is
        // last-value-wins, so stale frames are worthless.
        constexpr size_t TX_PENDING_CAP = 1024 * 1024;
        if (tx_pending.size() > TX_PENDING_CAP) {
            size_t drop = tx_pending.size() - TX_PENDING_CAP / 2;
            size_t nl = tx_pending.find('\n', drop);
            tx_pending.erase(0, nl == std::string::npos ? tx_pending.size() : nl + 1);
        }

        // ── Flush as much as the socket will take, honouring partial writes ──
        while (!tx_pending.empty() && sock_fd_ >= 0) {
            ssize_t sent = send(sock_fd_, tx_pending.data(), tx_pending.size(), MSG_NOSIGNAL);
            if (sent > 0) {
                tx_pending.erase(0, static_cast<size_t>(sent));
            } else if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                break;                       // socket buffer full — retry after poll()
            } else {
                // EPIPE / ECONNRESET / 0 — peer is gone; drop the connection.
                close(sock_fd_);
                sock_fd_ = -1;
                tx_pending.clear();
                break;
            }
        }

        // Block until the socket is readable (incoming command) or writable
        // again if we still owe it bytes — instead of a blind 10 ms sleep.
        if (sock_fd_ >= 0) {
            struct pollfd pfd;
            pfd.fd = sock_fd_;
            pfd.events = POLLIN | (tx_pending.empty() ? 0 : POLLOUT);
            pfd.revents = 0;
            poll(&pfd, 1, 10);
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
}

} // namespace ipc
} // namespace aes67_deck
