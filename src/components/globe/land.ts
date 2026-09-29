// The globe's land as one mesh of small hexagons (H3 cells at resolution 3, the
// look of three-globe's hexPolygons layer) instead of that layer's one mesh per
// country: one draw call instead of 176, never hit-tested by the hover raycast,
// and recoloured in place when the set of countries with clients changes.
import * as THREE from "three";
import { cellToBoundary, cellToLatLng, polygonToCells } from "h3-js";
import type { Feature, Geometry } from "geojson";

const RES = 3;
const MARGIN = 0.42;       // share of each cell left empty around its hexagon
const ALTITUDE = 0.004;

export interface Land {
  mesh: THREE.Mesh;
  /** Colours every country: lit ones (with clients) brighter. */
  paint: (lit: (f: Feature) => boolean) => void;
  dispose: () => void;
}

type Coords = (lat: number, lng: number, alt: number) => { x: number; y: number; z: number };

// Bright enough to read as land at a glance (v0.16.106's near-black earth read as
// a black ball, Jack 2026-09-29), still well under the client marks.
const LIT = [132 / 255, 152 / 255, 204 / 255, 0.7];
const DIM = [100 / 255, 116 / 255, 156 / 255, 0.48];

// Building the cells takes ~120ms, and the land never changes, so the geometry is
// built once per app session and reused by every later visit to the tab.
let cached: { geom: THREE.BufferGeometry; spans: { f: Feature; from: number; to: number }[] } | null = null;

export function buildLand(features: Feature<Geometry>[], getCoords: Coords): Land {
  if (!cached) cached = buildGeometry(features, getCoords);
  const { geom, spans } = cached;
  const colors = geom.getAttribute("color") as THREE.BufferAttribute;

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.raycast = () => {};   // scenery: hover tests run every 50ms and must skip it
  mesh.renderOrder = 1;

  const paint = (lit: (f: Feature) => boolean) => {
    const a = colors.array as Float32Array;
    for (const s of spans) {
      const c = lit(s.f) ? LIT : DIM;
      for (let v = s.from; v < s.to; v++) a.set(c, v * 4);
    }
    colors.needsUpdate = true;
  };
  paint(() => false);

  // The geometry stays cached; only this visit's material goes. The GPU copy
  // goes with the WebGL context, which the Globe tab releases on leave.
  return { mesh, paint, dispose: () => mat.dispose() };
}

function buildGeometry(features: Feature<Geometry>[], getCoords: Coords) {
  const pos: number[] = [];
  const idx: number[] = [];
  const spans: { f: Feature; from: number; to: number }[] = [];

  for (const f of features) {
    const g = f.geometry;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    const from = pos.length / 3;
    for (const poly of polys) {
      for (const cell of polygonToCells(poly as number[][][], RES, true)) {
        const [cLat, cLng] = cellToLatLng(cell);
        const c = getCoords(cLat, cLng, ALTITUDE);
        const base = pos.length / 3;
        pos.push(c.x, c.y, c.z);
        const ring = cellToBoundary(cell);
        for (const [lat, lng0] of ring) {
          // Keep the vertex on the centre's side of the antimeridian before shrinking.
          const lng = lng0 - cLng > 180 ? lng0 - 360 : lng0 - cLng < -180 ? lng0 + 360 : lng0;
          const v = getCoords(cLat + (lat - cLat) * (1 - MARGIN), cLng + (lng - cLng) * (1 - MARGIN), ALTITUDE);
          pos.push(v.x, v.y, v.z);
        }
        for (let i = 0; i < ring.length; i++) idx.push(base, base + 1 + i, base + 1 + ((i + 1) % ring.length));
      }
    }
    spans.push({ f, from, to: pos.length / 3 });
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  geom.setIndex(idx);
  return { geom, spans };
}
