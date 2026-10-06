#include <pthread.h>
#include "feed_handler.hpp"

static void pin_to_core(int core) {
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(core, &set);
  pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
}

int main() {
  pin_to_core(2);
  TickRing* ring = open_tick_ring(true);
  FeedHandler handler(ring);
  handler.run();
  return 0;
}
