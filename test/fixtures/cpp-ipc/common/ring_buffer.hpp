#pragma once
#include <atomic>
#include <cstddef>
#include <sys/mman.h>

// Single-producer/single-consumer ring living in POSIX shared memory.
template <typename T, size_t N>
struct alignas(64) RingBuffer {
  std::atomic<size_t> head{0};
  std::atomic<size_t> tail{0};
  T slots[N];

  bool push(const T& v) {
    size_t h = head.load(std::memory_order_relaxed);
    if (h - tail.load(std::memory_order_acquire) == N) return false;
    slots[h % N] = v;
    head.store(h + 1, std::memory_order_release);
    return true;
  }

  bool pop(T& out) {
    size_t t = tail.load(std::memory_order_relaxed);
    if (t == head.load(std::memory_order_acquire)) return false;
    out = slots[t % N];
    tail.store(t + 1, std::memory_order_release);
    return true;
  }
};

struct Tick {
  char symbol[8];
  double bid;
  double ask;
  long ts_ns;
};
