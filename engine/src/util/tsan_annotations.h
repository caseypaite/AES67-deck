#pragma once
// Happens-before annotations for ThreadSanitizer.
//
// The engine hands objects between threads through jack_ringbuffer_t, whose
// synchronisation (acquire/release on its internal read/write indices) lives
// inside uninstrumented libjack. TSan therefore can't see that a producer's
// writes happen-before a consumer's reads and reports fully-ordered accesses
// as races. Bracket each ring hand-off with these macros to restore the edge.
//
// No-ops unless the TU is built with -fsanitize=thread.

#if defined(__has_feature)
#  if __has_feature(thread_sanitizer)
#    define AES67_TSAN 1
#  endif
#endif
#if !defined(AES67_TSAN) && defined(__SANITIZE_THREAD__)
#  define AES67_TSAN 1
#endif

#if defined(AES67_TSAN)
#  include <sanitizer/tsan_interface.h>
// Producer: call right before jack_ringbuffer_write().
#  define AES67_TSAN_RELEASE(addr) \
     __tsan_release(const_cast<void*>(static_cast<const volatile void*>(addr)))
// Consumer: call right after jack_ringbuffer_read().
#  define AES67_TSAN_ACQUIRE(addr) \
     __tsan_acquire(const_cast<void*>(static_cast<const volatile void*>(addr)))
#else
#  define AES67_TSAN_RELEASE(addr) ((void)0)
#  define AES67_TSAN_ACQUIRE(addr) ((void)0)
#endif
