#pragma once
#include "../common/shm.hpp"

class FeedHandler {
 public:
  explicit FeedHandler(TickRing* ring) : ring_(ring) {}
  void run();

 private:
  bool decode(const char* packet, Tick& out);
  void publish(const Tick& t);
  TickRing* ring_;
};
