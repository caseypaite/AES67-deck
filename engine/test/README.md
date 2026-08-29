# Engine concurrency test

`tsan_driver.py` stands in for the bridge server: it listens on the engine's
IPC socket, accepts the engine's connection, then hammers every thread-crossing
control path (aux sends, faders, mute/solo/phase, plugin add/remove/load_rack,
transport locate/play, record start/stop, timeline set) while draining the
metering stream.

## ThreadSanitizer run

```sh
cd engine
cmake -B build-tsan -DSANITIZE=thread -DCMAKE_BUILD_TYPE=Debug
cmake --build build-tsan

python3 test/tsan_driver.py /tmp/aes67_tsan.sock 25 &
TSAN_OPTIONS="suppressions=$PWD/tsan.supp halt_on_error=0" \
  AES67_JACK_NAME=AES67_DeckTSan AES67_SOCKET_PATH=/tmp/aes67_tsan.sock \
  ./build-tsan/aes67_deck_engine
```

Expected: no data-race reports with an application frame. See `../tsan.supp`
for why the jack_ringbuffer-mediated reports are suppressed.
