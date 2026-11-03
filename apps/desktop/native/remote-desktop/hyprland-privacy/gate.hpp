#pragma once
#include <set>

// Only status crosses the process boundary. Never retain text or pointer paths.
struct PrivacyGate {
  enum Phase {
    Off,
    Active,
    Pending,
    Confirming,
    Resume,
    Disconnect
  } phase = Off;
  std::set<unsigned> held;
  bool consume(bool physical, unsigned key, bool down, bool trigger) {
    if (phase == Off)
      return false;
    // Main drains its old helper before presenting confirmation. Let that
    // helper release already-held input, but reject any new press immediately.
    if (!physical)
      return phase != Active && !(phase == Pending && !down && !trigger);
    if (held.contains(key)) {
      if (!down)
        held.erase(key);
      return true;
    }
    // Release a key/button pressed before privacy started. Dropping that edge
    // would leave the underlying application with a permanently held input.
    if (phase == Active && !down && !trigger)
      return false;
    if (phase == Active && trigger)
      phase = Pending;
    if (down)
      held.insert(key);
    return true;
  }
  void stop() {
    phase = Off;
    held.clear();
  }
};
