#pragma once
#include <zmq.hpp>

class OrderGateway {
 public:
  OrderGateway();
  void sendOrder(const char* symbol, char side, double px, int qty);

 private:
  zmq::context_t ctx_;
  zmq::socket_t socket_;
};
