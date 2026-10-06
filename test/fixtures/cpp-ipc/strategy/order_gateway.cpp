#include "order_gateway.hpp"
#include <cstdio>

OrderGateway::OrderGateway() : ctx_(1), socket_(ctx_, zmq::socket_type::push) {
  socket_.connect("ipc:///tmp/orders.sock");
}

void OrderGateway::sendOrder(const char* symbol, char side, double px, int qty) {
  char buf[64];
  int n = std::snprintf(buf, sizeof(buf), "%s,%c,%.4f,%d", symbol, side, px, qty);
  socket_.send(zmq::buffer(buf, n), zmq::send_flags::dontwait);
}
