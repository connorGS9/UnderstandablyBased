#pragma once
#include "../common/shm.hpp"
#include "order_gateway.hpp"

class MeanReversionStrategy {
 public:
  MeanReversionStrategy(TickRing* ring, OrderGateway* gw) : ring_(ring), gateway_(gw) {}
  void run();

 private:
  void onTick(const Tick& t);
  double fairValue(const Tick& t);
  TickRing* ring_;
  OrderGateway* gateway_;
  double ema_ = 0;
};
