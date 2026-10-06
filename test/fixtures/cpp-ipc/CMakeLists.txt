cmake_minimum_required(VERSION 3.20)
project(mini_hft CXX)
add_executable(feed_handler feed/main.cpp feed/feed_handler.cpp)
add_executable(strategy strategy/main.cpp strategy/strategy.cpp strategy/order_gateway.cpp)
