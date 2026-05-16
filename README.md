# bus.aolabs.io

Minimal WRTA live tracker and transfer-aware trip picker for saved Worcester destinations.

Fixed location pins:
- 96 William Street
- Alden Hall
- Union Station
- Chipotle
- Cold Stone
- Blackstone Theaters

Sources:
- WRTA SWIV live vehicle data.
- WRTA SWIV predicted and scheduled stop-arrival data for the selected boarding stop when GPS is available, with a location-nearest fallback when GPS is unavailable.
- WRTA route geometry through the existing Ride Guide route endpoints.
- Ride Guide schedules for direct and one-transfer trip options.
- OpenStreetMap tiles.

Paper:
- `/paper.pdf`
- Source: `manuscripts/bus_nature_style/main.tex`
