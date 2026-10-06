#include "strategy.hpp"

int main() {
  TickRing* ring = open_tick_ring(false);
  OrderGateway gateway;
  MeanReversionStrategy strategy(ring, &gateway);
  strategy.run();
  return 0;
}
