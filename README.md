# bus.aolabs.io

Personal WRTA bus-tracking PWA with Route 31 to Chipotle as the saved first trip.

Sources:
- WRTA SWIV live vehicle and stop-prediction data.
- Ride Guide WRTA schedule, stop, and route geometry data embedded from official WRTA route pages.
- Browser GPS for Alan's current location.
- OSRM walking-route estimates, with straight-line fallback when routing is unavailable.

The app keeps one stable screen: current instruction, fixed clock-time facts, map, route, user location, boarding stop, exit stop, destination, and live bus marker. Route 31 is the default saved trip, not the product boundary.
