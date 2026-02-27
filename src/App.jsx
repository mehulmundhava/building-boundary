import { useRef, useEffect, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import * as turf from '@turf/turf'
import 'maplibre-gl/dist/maplibre-gl.css'
import './App.css'

const MAPTILER_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${import.meta.env.VITE_MAPTILER_API_KEY || ''}`

// Bounding box buffer for initial click detection (center ± N → (2N+1)x(2N+1) px)
const QUERY_RADIUS_PX = 3
const FLY_TO_ZOOM = 17.5
const DISCOVERY_ZOOM = 13.5            // lower zoom for Phase 1 — broad tile coverage to discover full building extent
const SOURCE_QUERY_DELAY_MS = 150

// ── Area-Guard & Distance-Guard thresholds (defaults, can be overridden per-call) ──
const AREA_MULTIPLIER = 3.0           // max cluster area = seed area × this
const MAX_NEIGHBOR_DISTANCE_KM = 0.05 // 50 m — reject polygons farther than this from seed centroid

// Ray-casting: is point [lng, lat] inside polygon ring (array of [lng, lat])?
function pointInRing(point, ring) {
  const [x, y] = point
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Get a single Polygon from feature at the given lngLat. MultiPolygon → one polygon containing the point.
function toSinglePolygon(feature, lngLat) {
  if (!feature?.geometry) return null
  const { type, coordinates } = feature.geometry
  const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat]

  if (type === 'Polygon') {
    return { type: 'Polygon', coordinates }
  }
  if (type === 'MultiPolygon') {
    const point = [lng, lat]
    for (const polygon of coordinates) {
      const exteriorRing = polygon[0]
      if (exteriorRing?.length && pointInRing(point, exteriorRing)) {
        return { type: 'Polygon', coordinates: polygon }
      }
    }
    return { type: 'Polygon', coordinates: coordinates[0] }
  }
  return null
}

function buildGeoJSONFromFeature(feature, geometry) {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null
  return {
    type: 'Feature',
    properties: feature.properties || {},
    geometry
  }
}

// Count coordinate pairs in a geometry (for choosing "most detailed" feature)
function countCoords(geometry) {
  if (!geometry || !geometry.coordinates) return 0
  const c = geometry.coordinates
  if (geometry.type === 'Polygon') return (c[0] && c[0].length) || 0
  if (geometry.type === 'MultiPolygon') {
    return c.reduce((sum, poly) => sum + ((poly[0] && poly[0].length) || 0), 0)
  }
  return 0
}

// Extract flat list of polygon coordinate arrays from features (Polygon or MultiPolygon).
// Returns { coords, turfPolys } so we can reuse Turf polygon objects and avoid reference ambiguity.
function extractPolygonCoords(features) {
  const coords = []
  const turfPolys = []
  for (const f of features) {
    if (!f?.geometry?.coordinates) continue
    const { type, coordinates } = f.geometry
    if (type === 'Polygon' && coordinates[0]?.length) {
      try {
        coords.push(coordinates)
        turfPolys.push(turf.polygon(coordinates))
      } catch (_) {
        coords.push(coordinates)
        turfPolys.push(null)
      }
    } else if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
      for (const polygonCoords of coordinates) {
        if (!polygonCoords?.[0]?.length) continue
        try {
          coords.push(polygonCoords)
          turfPolys.push(turf.polygon(polygonCoords))
        } catch (_) {
          coords.push(polygonCoords)
          turfPolys.push(null)
        }
      }
    }
  }
  return { coords, turfPolys }
}

// ── Bulletproof building extraction ──
// "Click-Point Isolation First" strategy:
//   1. ALWAYS flatten every feature into individual polygons (no early returns)
//   2. Find the single Seed polygon containing the click lat/lng
//   3. Only merge truly adjacent tile-fragments with strict Area + Distance guards
//   4. Final output is ALWAYS a single Polygon (never MultiPolygon)
function pickOrMergeSourceFeatures(features, lngLat, options = {}) {
  if (!features || features.length === 0) return null

  const areaMultiplier = options.areaMultiplier || AREA_MULTIPLIER
  const maxDistanceKm = options.maxDistanceKm || MAX_NEIGHBOR_DISTANCE_KM

  // ── 0) Flatten ALL features into individual polygons ──
  // Even a single feature can be a MultiPolygon containing dozens of separate buildings.
  const { coords: allCoords, turfPolys } = extractPolygonCoords(features)
  if (allCoords.length === 0) return features[0]

  const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat]
  const clickPt = turf.point([lng, lat])

  // If only one polygon exists after flattening, return it directly
  if (allCoords.length === 1) {
    return { ...features[0], geometry: { type: 'Polygon', coordinates: allCoords[0] } }
  }

  // ── 1) Seed identification ──
  // Find the smallest polygon that actually contains the user's lat/lng.
  let seedIndex = -1
  let seedArea = Infinity
  for (let i = 0; i < allCoords.length; i++) {
    const poly = turfPolys[i]
    if (!poly) continue
    try {
      if (turf.booleanPointInPolygon(clickPt, poly)) {
        const a = turf.area(poly)
        if (a < seedArea) {
          seedArea = a
          seedIndex = i
        }
      }
    } catch (_) {
      continue
    }
  }

  // Fallback: ray-casting on raw coords
  if (seedIndex === -1) {
    for (let i = 0; i < allCoords.length; i++) {
      if (allCoords[i]?.[0] && pointInRing([lng, lat], allCoords[i][0])) {
        seedIndex = i
        const poly = turfPolys[i]
        seedArea = poly ? turf.area(poly) : 0
        break
      }
    }
  }

  // Last-resort fallback: pick the closest polygon to the click point
  if (seedIndex === -1) {
    let minDist = Infinity
    for (let i = 0; i < allCoords.length; i++) {
      const poly = turfPolys[i]
      if (!poly) continue
      try {
        const d = turf.distance(clickPt, turf.centroid(poly), { units: 'kilometers' })
        if (d < minDist) {
          minDist = d
          seedIndex = i
          seedArea = turf.area(poly)
        }
      } catch (_) {
        continue
      }
    }
  }

  if (seedIndex === -1) return features[0]

  // Precompute seed centroid for distance-guard
  const seedPoly = turfPolys[seedIndex]
  const seedCentroid = seedPoly ? turf.centroid(seedPoly) : clickPt
  if (!seedArea || seedArea <= 0) {
    seedArea = seedPoly ? turf.area(seedPoly) : 0
  }
  const maxClusterArea = seedArea * areaMultiplier

  // Precompute areas and centroids for all polygons
  const areas = allCoords.map((_, i) => {
    const p = turfPolys[i]
    if (!p) return 0
    try { return turf.area(p) } catch (_) { return 0 }
  })
  const centroids = allCoords.map((_, i) => {
    const p = turfPolys[i]
    if (!p) return null
    try { return turf.centroid(p) } catch (_) { return null }
  })

  // ── 2) Strict expansion: only merge adjacent tile-fragments ──
  // A candidate must: touch the cluster, pass area guard, AND pass distance guard.
  const cluster = new Set([seedIndex])
  let clusterArea = areas[seedIndex] || 0
  let changed = true

  while (changed) {
    changed = false
    for (let i = 0; i < allCoords.length; i++) {
      if (cluster.has(i)) continue
      const poly = turfPolys[i]
      if (!poly) continue

      try {
        // ── Distance Guard (check first — cheapest) ──
        const candidateCentroid = centroids[i]
        if (candidateCentroid) {
          const dist = turf.distance(seedCentroid, candidateCentroid, { units: 'kilometers' })
          if (dist > maxDistanceKm) continue
        }

        // ── Area Guard ──
        const candidateArea = areas[i] || 0
        if (maxClusterArea > 0 && (clusterArea + candidateArea) > maxClusterArea) continue

        // ── Geometric connectivity: must truly touch/overlap a cluster member ──
        const touchesCluster = [...cluster].some((j) => {
          const other = turfPolys[j]
          if (!other) return false
          try { return turf.booleanIntersects(poly, other) } catch (_) { return false }
        })
        if (!touchesCluster) continue

        // Passed all guards → add to cluster
        cluster.add(i)
        clusterArea += candidateArea
        changed = true
      } catch (_) {
        continue
      }
    }
  }

  // ── 3) Union the cluster into a single geometry ──
  const clusterCoords = [...cluster].map((i) => allCoords[i])

  if (clusterCoords.length === 0) {
    return { ...features[0], geometry: { type: 'Polygon', coordinates: allCoords[seedIndex] } }
  }
  if (clusterCoords.length === 1) {
    return { ...features[0], geometry: { type: 'Polygon', coordinates: clusterCoords[0] } }
  }

  let unionResult = null
  try {
    unionResult = turf.polygon(clusterCoords[0])
    for (let i = 1; i < clusterCoords.length; i++) {
      try {
        const next = turf.polygon(clusterCoords[i])
        unionResult = turf.union(turf.featureCollection([unionResult, next]))
        if (!unionResult) break
      } catch (_) {
        continue
      }
    }
  } catch (_) {
    unionResult = null
  }

  // ── 4) Force single Polygon output ──
  // If union produced a MultiPolygon, keep ONLY the sub-polygon containing the click point.
  let finalGeometry = null

  if (unionResult?.geometry) {
    const geom = unionResult.geometry

    if (geom.type === 'MultiPolygon' && geom.coordinates.length > 1) {
      let bestIdx = 0
      let bestArea = 0
      for (let i = 0; i < geom.coordinates.length; i++) {
        try {
          const subPoly = turf.polygon(geom.coordinates[i])
          if (turf.booleanPointInPolygon(clickPt, subPoly)) {
            bestIdx = i
            break
          }
          const a = turf.area(subPoly)
          if (a > bestArea) {
            bestArea = a
            bestIdx = i
          }
        } catch (_) {
          continue
        }
      }
      finalGeometry = { type: 'Polygon', coordinates: geom.coordinates[bestIdx] }
    } else if (geom.type === 'MultiPolygon' && geom.coordinates.length === 1) {
      finalGeometry = { type: 'Polygon', coordinates: geom.coordinates[0] }
    } else {
      finalGeometry = geom
    }
  }

  // Fallback if union failed entirely
  if (!finalGeometry) {
    finalGeometry = clusterCoords.length === 1
      ? { type: 'Polygon', coordinates: clusterCoords[0] }
      : { type: 'MultiPolygon', coordinates: clusterCoords }
  }

  // ── 5) Geometry cleanup: remove duplicate vertices from tile seams ──
  try {
    const cleaned = turf.cleanCoords(turf.feature(finalGeometry))
    if (cleaned?.geometry) finalGeometry = cleaned.geometry
  } catch (_) { /* keep as-is */ }

  return { ...features[0], geometry: finalGeometry }
}

function App() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const markerOnMapRef = useRef(false)
  const highlightSourceId = 'building-highlight'
  const highlightLayerId = 'building-highlight-layer'
  const [geoJSON, setGeoJSON] = useState(null)
  const [error, setError] = useState(null)
  const [isLoadingBuilding, setIsLoadingBuilding] = useState(false)
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [isRunningTests, setIsRunningTests] = useState(false)
  const [testProgress, setTestProgress] = useState('')
  const testAbortRef = useRef(false)

  const clearHighlight = useCallback((map) => {
    if (!map) return
    if (map.getLayer(highlightLayerId)) map.removeLayer(highlightLayerId)
    if (map.getSource(highlightSourceId)) map.removeSource(highlightSourceId)
  }, [])

  const showHighlight = useCallback((map, polygonGeometry) => {
    clearHighlight(map)
    if (
      !polygonGeometry ||
      (polygonGeometry.type !== 'Polygon' && polygonGeometry.type !== 'MultiPolygon') ||
      !polygonGeometry.coordinates
    )
      return
    map.addSource(highlightSourceId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: polygonGeometry
      }
    })
    map.addLayer({
      id: highlightLayerId,
      type: 'line',
      source: highlightSourceId,
      paint: {
        'line-color': '#e53935',
        'line-width': 3
      }
    })
  }, [clearHighlight])

  const getBuildingFeatureAtPoint = useCallback((map, point, lngLat) => {
    const x = point.x ?? point[0]
    const y = point.y ?? point[1]
    const bbox = [
      [x - QUERY_RADIUS_PX, y - QUERY_RADIUS_PX],
      [x + QUERY_RADIUS_PX, y + QUERY_RADIUS_PX]
    ]
    const rendered = map.queryRenderedFeatures(bbox)
    const renderedBuilding = rendered.find(
      (f) =>
        f.geometry &&
        (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
        (f.layer?.id?.toLowerCase().includes('building') || f.layer?.type === 'fill')
    )
    if (!renderedBuilding) return null

    const sourceId = renderedBuilding.source
    const sourceLayer = renderedBuilding.sourceLayer
    // Vector tiles may expose id as top-level or in properties.id / properties.osm_id
    const featureId =
      renderedBuilding.id ??
      renderedBuilding.properties?.id ??
      renderedBuilding.properties?.osm_id

    if (sourceId && sourceLayer != null && featureId !== undefined && featureId !== null) {
      const filtersToTry = [
        ['==', ['id'], featureId],
        ['==', ['get', 'id'], featureId],
        ['==', ['get', 'osm_id'], featureId]
      ]
      for (const filter of filtersToTry) {
        try {
          const sourceFeatures = map.querySourceFeatures(sourceId, {
            sourceLayer,
            filter
          })
          if (sourceFeatures && sourceFeatures.length > 0) {
            const merged = pickOrMergeSourceFeatures(sourceFeatures, lngLat)
            if (merged) return merged
            break
          }
        } catch (_) {
          continue
        }
      }
    }
    return renderedBuilding
  }, [])

  useEffect(() => {
    if (!mapContainerRef.current) return

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAPTILER_STYLE_URL,
      center: [0, 0],
      zoom: 2
    })

    map.addControl(new maplibregl.NavigationControl(), 'top-right')

    const markerEl = document.createElement('div')
    markerEl.className = 'input-location-marker'
    const marker = new maplibregl.Marker({ element: markerEl })
    markerRef.current = marker

    map.on('load', () => {
      setError(null)
      map.getCanvas().style.cursor = 'default'
    })

    map.on('error', (e) => {
      if (e?.error?.message) setError(e.error.message)
    })

    const applyBuildingAtPoint = (map, point, lngLat) => {
      setIsLoadingBuilding(true)
      if (typeof console !== 'undefined' && console.log) {
        console.log('[Building extraction] querySourceFeatures running…')
      }
      try {
        const feature = getBuildingFeatureAtPoint(map, point, lngLat)
        if (feature?.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon')) {
          showHighlight(map, feature.geometry)
          setGeoJSON(buildGeoJSONFromFeature(feature, feature.geometry))
        } else {
          clearHighlight(map)
          setGeoJSON(null)
        }
      } finally {
        setIsLoadingBuilding(false)
      }
    }

    map.on('click', (e) => {
      applyBuildingAtPoint(map, e.point, e.lngLat)
    })

    map.on('mousemove', (e) => {
      const feature = getBuildingFeatureAtPoint(map, e.point, e.lngLat)
      map.getCanvas().style.cursor = feature ? 'pointer' : 'default'
    })

    mapRef.current = map
    return () => {
      if (markerOnMapRef.current) marker.remove()
      markerOnMapRef.current = false
      markerRef.current = null
      clearHighlight(map)
      map.remove()
      mapRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current
    const marker = markerRef.current
    if (!map || !marker) return
    const latNum = parseFloat(lat)
    const lngNum = parseFloat(lng)
    if (!Number.isNaN(latNum) && !Number.isNaN(lngNum)) {
      marker.setLngLat([lngNum, latNum])
      if (!markerOnMapRef.current) {
        marker.addTo(map)
        markerOnMapRef.current = true
      }
    } else if (markerOnMapRef.current) {
      marker.remove()
      markerOnMapRef.current = false
    }
  }, [lat, lng])

  const handleDownloadGeoJSON = () => {
    if (!geoJSON) return
    const blob = new Blob([JSON.stringify(geoJSON, null, 2)], { type: 'application/geo+json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `building-boundary-${Date.now()}.geojson`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleGetBuildingAtLocation = useCallback(() => {
    const map = mapRef.current
    const latNum = parseFloat(lat)
    const lngNum = parseFloat(lng)
    if (!map || isNaN(latNum) || isNaN(lngNum)) {
      setError('Enter valid latitude and longitude.')
      return
    }
    setError(null)
    clearHighlight(map)
    setGeoJSON(null)
    setIsLoadingBuilding(true)

    // ── Configuration ──
    const ZOOM_CASCADE = [13.5, 15.5, 17.5, 19.5] // try from broadest to most precise
    const MAX_PASSES = 6
    const BBOX_GROWTH = 0.10
    const POINT_BUFFER_M = 10 // 10 m tolerance for point-in-polygon validation

    const clickPt = turf.point([lngNum, latNum])

    // ── Validation: is the click point inside the polygon? (with buffer) ──
    const isPointInsideResult = (geometry) => {
      if (!geometry) return false
      try {
        const feat = turf.feature(geometry)
        // Direct check
        if (turf.booleanPointInPolygon(clickPt, feat)) return true
        // Buffer check: is the point within 10m of the polygon?
        const buffered = turf.buffer(feat, POINT_BUFFER_M, { units: 'meters' })
        if (buffered && turf.booleanPointInPolygon(clickPt, buffered)) return true
      } catch (_) { }
      return false
    }

    // ── Discover building at a given zoom, run iterative expansion, return result ──
    const discoverAtZoom = (zoom, onResult) => {
      console.log(`[Building] ── Trying zoom ${zoom} ──`)
      map.flyTo({ center: [lngNum, latNum], zoom, duration: 400 })
      map.once('idle', () => {
        setTimeout(() => {
          // Find building at rendered level
          const point = map.project([lngNum, latNum])
          const x = point.x ?? point[0]
          const y = point.y ?? point[1]
          const bboxPx = [
            [x - QUERY_RADIUS_PX, y - QUERY_RADIUS_PX],
            [x + QUERY_RADIUS_PX, y + QUERY_RADIUS_PX]
          ]
          const rendered = map.queryRenderedFeatures(bboxPx)
          const building = rendered.find(
            (f) =>
              f.geometry &&
              (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
              (f.layer?.id?.toLowerCase().includes('building') || f.layer?.type === 'fill')
          )
          if (!building) {
            onResult(null) // no building found at this zoom
            return
          }

          const sourceId = building.source
          const sourceLayer = building.sourceLayer
          const featureId =
            building.id ??
            building.properties?.id ??
            building.properties?.osm_id

          // Find working filter
          let workingFilter = null
          if (sourceId && sourceLayer != null && featureId != null) {
            for (const filter of [
              ['==', ['id'], featureId],
              ['==', ['get', 'id'], featureId],
              ['==', ['get', 'osm_id'], featureId]
            ]) {
              try {
                const sf = map.querySourceFeatures(sourceId, { sourceLayer, filter })
                if (sf && sf.length > 0) { workingFilter = filter; break }
              } catch (_) { continue }
            }
          }

          if (!workingFilter || !sourceId || sourceLayer == null) {
            // No source query possible — use rendered feature directly
            const geom = toSinglePolygon(building, [lngNum, latNum]) || building.geometry
            onResult(geom ? { feature: building, geometry: geom } : null)
            return
          }

          // ── Iterative expansion at this zoom level ──
          let currentMerged = null
          let currentGeom = building.geometry
          let prevDiagonal = 0
          let passNumber = 0

          // Initial discovery query at current zoom
          try {
            const sf = map.querySourceFeatures(sourceId, { sourceLayer, filter: workingFilter })
            if (sf && sf.length > 0) {
              const merged = pickOrMergeSourceFeatures(sf, [lngNum, latNum])
              if (merged?.geometry) {
                currentMerged = merged
                currentGeom = merged.geometry
              }
            }
          } catch (_) { }

          const runPass = () => {
            passNumber++
            if (!currentGeom || passNumber > MAX_PASSES) {
              onResult(currentMerged ? { feature: currentMerged, geometry: currentGeom } : null)
              return
            }

            const bboxGeo = turf.bbox(turf.feature(currentGeom))
            const diagonal = turf.distance(
              turf.point([bboxGeo[0], bboxGeo[1]]),
              turf.point([bboxGeo[2], bboxGeo[3]]),
              { units: 'kilometers' }
            )

            const growth = prevDiagonal > 0 ? (diagonal - prevDiagonal) / prevDiagonal : 1
            if (passNumber > 1 && growth < BBOX_GROWTH) {
              console.log(`[Building] z${zoom} pass ${passNumber} — converged`)
              onResult(currentMerged ? { feature: currentMerged, geometry: currentGeom } : null)
              return
            }
            prevDiagonal = diagonal

            const adaptiveDistanceKm = Math.max(MAX_NEIGHBOR_DISTANCE_KM, diagonal * 2.0)
            const adaptiveAreaMultiplier = Math.max(AREA_MULTIPLIER, 10.0)

            console.log(`[Building] z${zoom} pass ${passNumber} — fitBounds (diag=${diagonal.toFixed(3)}km)`)
            map.fitBounds(
              [[bboxGeo[0], bboxGeo[1]], [bboxGeo[2], bboxGeo[3]]],
              { padding: 120, maxZoom: FLY_TO_ZOOM, duration: 300 }
            )

            map.once('idle', () => {
              setTimeout(() => {
                try {
                  const features = map.querySourceFeatures(sourceId, { sourceLayer, filter: workingFilter })
                  if (features && features.length > 0) {
                    const merged = pickOrMergeSourceFeatures(
                      features, [lngNum, latNum],
                      { areaMultiplier: adaptiveAreaMultiplier, maxDistanceKm: adaptiveDistanceKm }
                    )
                    if (merged?.geometry) {
                      currentMerged = merged
                      currentGeom = merged.geometry
                    }
                  }
                } catch (_) { }
                runPass()
              }, SOURCE_QUERY_DELAY_MS)
            })
          }

          runPass()
        }, SOURCE_QUERY_DELAY_MS)
      })
    }

    // ── Cascading zoom: try each zoom level, validate, escalate if needed ──
    let zoomIndex = 0
    let bestResult = null // keep the best result across zooms as fallback

    const tryNextZoom = () => {
      if (zoomIndex >= ZOOM_CASCADE.length) {
        // All zooms tried — use the best result we found (even if validation failed)
        if (bestResult) {
          console.log('[Building] All zooms tried — using best available result')
          showHighlight(map, bestResult.geometry)
          setGeoJSON(buildGeoJSONFromFeature(bestResult.feature, bestResult.geometry))
        } else {
          setError('No building found at this location.')
        }
        setIsLoadingBuilding(false)
        return
      }

      const zoom = ZOOM_CASCADE[zoomIndex]
      zoomIndex++

      discoverAtZoom(zoom, (result) => {
        if (!result || !result.geometry) {
          console.log(`[Building] z${zoom} — no building found, trying next zoom`)
          tryNextZoom()
          return
        }

        // Keep as best result (higher zoom results are more precise)
        bestResult = result

        // ── Validate: is the click point inside the extracted polygon? ──
        if (isPointInsideResult(result.geometry)) {
          console.log(`[Building] ✓ z${zoom} — VALIDATED (point inside polygon)`)
          showHighlight(map, result.geometry)
          setGeoJSON(buildGeoJSONFromFeature(result.feature, result.geometry))
          setIsLoadingBuilding(false)
        } else {
          console.log(`[Building] ✗ z${zoom} — point NOT inside polygon, escalating...`)
          tryNextZoom()
        }
      })
    }

    tryNextZoom()
  }, [lat, lng, showHighlight, clearHighlight])

  // ── Test Runner: auto-run all lat/lng from the test list ──
  const TEST_COORDINATES = [
    [49.06114, -122.49594],
    [50.99507, -113.96369],
    [39.53652, -84.30099],
    [39.59358, -86.09508],
    [33.65604, -117.718598],
    [37.71727, -121.51804],
    [47.27738, -122.234526],
    [40.21300507, -76.0802536],
    [38.93801, -94.84897],
    [40.88931, -84.6097],
    [41.5582, -90.4346],
    [28.58543, -81.41385],
    [28.03257942, -82.05041504],
    [34.04669189, -117.6206131],
    [33.73733, -84.56177],
    [32.7696514, -96.8901692],
    [41.40439777510291, -88.12477561852806],
    [41.46080917, -88.10173598],
    [41.44887833, -88.29277723],
    [43.51063588, -88.79531788],
    [41.98487941, -84.9802332],
    [44.8972224, -91.86311665],
    [40.97655267, -91.5282162],
    [41.35273813, -89.22253163],
    [41.46080917, -88.10173598],
    [41.44887833, -88.29277723],
    [55.37545776, -131.7204742],
    [29.89539, -90.05731],
    [36.670022, -76.95544],
    [35.81965256, -79.82302094],
    [34.155258, -79.764127],
    [37.06111908, -93.2988739],
    [42.66067123, -83.46760559],
  ]

  const handleRunAllTests = useCallback(() => {
    if (isRunningTests) {
      testAbortRef.current = true
      setIsRunningTests(false)
      setTestProgress('')
      return
    }
    testAbortRef.current = false
    setIsRunningTests(true)
    let idx = 0

    const runNext = () => {
      if (testAbortRef.current || idx >= TEST_COORDINATES.length) {
        setIsRunningTests(false)
        setTestProgress(testAbortRef.current ? 'Aborted' : `Done — ${TEST_COORDINATES.length}/${TEST_COORDINATES.length}`)
        return
      }
      const [tLat, tLng] = TEST_COORDINATES[idx]
      setTestProgress(`${idx + 1}/${TEST_COORDINATES.length} — (${tLat}, ${tLng})`)
      setLat(String(tLat))
      setLng(String(tLng))
      idx++

      // Wait for React to flush state, then click the real button
      setTimeout(() => {
        const btn = document.getElementById('btn-get-building')
        if (btn) btn.click()

        // Poll until extraction finishes (button becomes enabled again)
        const poll = setInterval(() => {
          if (testAbortRef.current) {
            clearInterval(poll)
            return
          }
          const b = document.getElementById('btn-get-building')
          if (b && !b.disabled) {
            clearInterval(poll)
            // 5 sec viewing delay before next test
            setTimeout(runNext, 5000)
          }
        }, 500)
      }, 300)
    }

    runNext()
  }, [isRunningTests])

  return (
    <div className="app">
      <div ref={mapContainerRef} className="map-container" />
      {error && (
        <div className="error-banner">
          {error}
        </div>
      )}
      <aside className="panel">
        <h2 className="panel-title">Building boundary</h2>
        <p className="panel-hint">Enter latitude and longitude to get the building boundary (Polygon or MultiPolygon). Supports small and large buildings across tiles.</p>
        <div className="panel-inputs">
          <button
            type="button"
            className="btn-get"
            onClick={handleRunAllTests}
            disabled={isLoadingBuilding && !isRunningTests}
            style={{ marginBottom: 8, background: isRunningTests ? '#e53935' : '#ff9800' }}
          >
            {isRunningTests ? '⏹ Stop Tests' : '▶ Run All Tests'}
          </button>
          {testProgress && (
            <p style={{ fontSize: 12, margin: '0 0 8px', color: '#555', fontWeight: 500 }}>
              {testProgress}
            </p>
          )}
          <label className="input-label">
            Latitude
            <input
              type="text"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="e.g. 22.308"
              className="input-field"
            />
          </label>
          <label className="input-label">
            Longitude
            <input
              type="text"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="e.g. 78.786"
              className="input-field"
            />
          </label>
          <button
            type="button"
            id="btn-get-building"
            className="btn-get"
            onClick={handleGetBuildingAtLocation}
            disabled={isLoadingBuilding}
          >
            {isLoadingBuilding ? 'Loading…' : 'Get building at location'}
          </button>
        </div>
        {isLoadingBuilding && (
          <p className="panel-loading">Querying source features for full boundary…</p>
        )}
        {!isLoadingBuilding && geoJSON ? (
          <>
            <div className="panel-actions">
              <button type="button" className="btn-download" onClick={handleDownloadGeoJSON}>
                Download GeoJSON
              </button>
            </div>
            <div className="panel-json">
              <pre>{JSON.stringify(geoJSON, null, 2)}</pre>
            </div>
          </>
        ) : !isLoadingBuilding ? (
          <p className="panel-empty">Enter lat/long and click &quot;Get building at location&quot; to see the full boundary (no clipping at tile edges).</p>
        ) : null}
      </aside>
    </div>
  )
}

export default App
