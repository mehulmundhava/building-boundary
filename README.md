# Building Boundary Extractor

A React + Vite app that extracts building boundaries from map vector tiles using MapLibre GL JS and MapTiler Streets v2.

## Setup

1. **Get a MapTiler API key** (free at [maptiler.com](https://www.maptiler.com/)).
2. **Set the API key** in a `.env` file in the project root:
   ```bash
   VITE_MAPTILER_API_KEY=your_actual_key_here
   ```
   Or copy `.env.example` to `.env` and replace the placeholder. (Do not commit `.env`; it is gitignored.)

## Run

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (e.g. http://localhost:5173).

## Usage

- **Click** a building on the map to extract its boundary from the vector tiles (via `queryRenderedFeatures`).
- The building outline is **highlighted with a red stroke**.
- The **left panel** shows the raw GeoJSON of the selected building.
- Use **Download GeoJSON** to save the boundary as a `.geojson` file.
- The cursor becomes a **pointer** when hovering over buildings.

## Stack

- React 18, Vite 5, MapLibre GL JS 4, MapTiler Streets v2
