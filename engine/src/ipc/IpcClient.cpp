#include "IpcClient.h"
#include <iostream>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <vector>
#include "json.hpp"

namespace aes67_deck {
namespace ipc {

IpcClient::IpcClient(const std::string& socket_path) : socket_path_(socket_path), sock_fd_(-1), running_(false) {
    tx_buffer_ = jack_ringbuffer_create(1024 * 64); // 64KB buffer
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
void IpcClient::set_plugin_callback(std::function<void(const std::string&, int, int, const std::string&, float)> cb) {
    plugin_callback_ = cb;
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
                    } else if (type == "set_plugin_param" || type == "set_plugin_bypass") {
                        int channel = j.value("channel", -1);
                        int p_idx = j.value("pluginIndex", -1);
                        if (channel != -1 && p_idx != -1) {
                            float val = j.value("value", 0.0f);
                            std::string p_id = j.value("paramId", "");
                            if (plugin_callback_) plugin_callback_(type, channel, p_idx, p_id, val);
                        }
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

        // Write outgoing telemetry
        size_t avail = jack_ringbuffer_read_space(tx_buffer_);
        if (avail > 0 && sock_fd_ >= 0) {
            size_t to_read = std::min(avail, tx_scratch.size());
            jack_ringbuffer_read(tx_buffer_, tx_scratch.data(), to_read);
            send(sock_fd_, tx_scratch.data(), to_read, MSG_NOSIGNAL);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

} // namespace ipc
} // namespace aes67_deck
