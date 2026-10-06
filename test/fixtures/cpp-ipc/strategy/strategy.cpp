#include "strategy.hpp"

void MeanReversionStrategy::run() {
  Tick t{};
  while (true) {
    if (ring_->pop(t)) onTick(t);
  }
}

void MeanReversionStrategy::onTick(const Tick& t) {
  double fv = fairValue(t);
  if (t.ask < fv * 0.999) gateway_->sendOrder(t.symbol, 'B', t.ask, 100);
  else if (t.bid > fv * 1.001) gateway_->sendOrder(t.symbol, 'S', t.bid, 100);
}

double MeanReversionStrategy::fairValue(const Tick& t) {
  double mid = (t.bid + t.ask) / 2;
  ema_ = ema_ == 0 ? mid : ema_ * 0.99 + mid * 0.01;
  return ema_;
}
