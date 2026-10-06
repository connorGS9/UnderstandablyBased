#include "feed_handler.hpp"
#include <cstring>
#include <x86intrin.h>

void FeedHandler::run() {
  char packet[256];
  Tick t{};
  while (true) {
    // busy-poll the NIC; in production this would be kernel-bypass (e.g. ef_vi)
    if (decode(packet, t)) publish(t);
    _mm_pause();
  }
}

bool FeedHandler::decode(const char* packet, Tick& out) {
  std::memcpy(&out, packet, sizeof(Tick));
  out.ts_ns = __rdtsc();
  return __builtin_expect(out.bid > 0, 1);
}

void FeedHandler::publish(const Tick& t) {
  while (!ring_->push(t)) _mm_pause();
}
