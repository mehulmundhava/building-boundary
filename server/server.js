require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const MAPTILER_API_KEY = process.env.MAPTILER_API_KEY || process.env.VITE_MAPTILER_API_KEY || '';

if (!MAPTILER_API_KEY) {
  console.warn('[WARN] No MAPTILER_API_KEY found in .env — map tiles may fail to load.');
}

// ── Puppeteer browser singleton ──
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  console.log('[Puppeteer] Launching headless Chrome with WebGL...');
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=swiftshader',       // Software WebGL — works without GPU
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });
  console.log('[Puppeteer] Browser ready.');
  return browserInstance;
}

// ── GET /get-boundary?lat=X&lng=Y ──
app.get('/get-boundary', async (req, res) => {
  const { lat, lng } = req.query;
  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);

  if (isNaN(latNum) || isNaN(lngNum)) {
    return res.status(400).json({ error: 'Invalid lat/lng. Use: /get-boundary?lat=41.45&lng=-88.30' });
  }

  console.log(`\n[API] Request: lat=${latNum}, lng=${lngNum}`);
  const startTime = Date.now();

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set viewport large enough for map tiles to render
    await page.setViewport({ width: 1280, height: 900 });

    // Load the map-engine HTML page
    const htmlPath = path.resolve(__dirname, 'map-engine.html');
    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });

    // Inject the MapTiler API key and coordinates into the page
    const result = await page.evaluate(async (apiKey, latitude, longitude) => {
      // The map-engine.html exposes a global function: extractBuildingBoundary(apiKey, lat, lng)
      // It returns a Promise that resolves to { geojson, error, logs }
      return await window.extractBuildingBoundary(apiKey, latitude, longitude);
    }, MAPTILER_API_KEY, latNum, lngNum);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    // Forward console logs from the headless page
    if (result.logs && result.logs.length > 0) {
      result.logs.forEach(l => console.log(`  [MapEngine] ${l}`));
    }

    if (result.error) {
      console.log(`[API] Error after ${elapsed}s: ${result.error}`);
      return res.status(404).json({ error: result.error, elapsed_s: elapsed });
    }

    console.log(`[API] Success after ${elapsed}s — ${result.geojson?.geometry?.type || 'unknown'}`);
    return res.json({
      success: true,
      elapsed_s: elapsed,
      input: { lat: latNum, lng: lngNum },
      geojson: result.geojson,
    });
  } catch (err) {
    console.error('[API] Fatal error:', err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser_connected: !!(browserInstance && browserInstance.connected) });
});

// ── Graceful shutdown ──
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  Building Boundary API                     ║`);
  console.log(`║  http://localhost:${PORT}/get-boundary?lat=X&lng=Y ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
});
