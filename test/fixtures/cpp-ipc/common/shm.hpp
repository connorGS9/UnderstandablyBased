#pragma once
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include "ring_buffer.hpp"

using TickRing = RingBuffer<Tick, 4096>;

inline TickRing* open_tick_ring(bool create) {
  int fd = shm_open("/md_ticks", create ? (O_CREAT | O_RDWR) : O_RDWR, 0600);
  if (create) ftruncate(fd, sizeof(TickRing));
  void* p = mmap(nullptr, sizeof(TickRing), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  return static_cast<TickRing*>(p);
}
