import { describe, expect, it } from "vitest";
import { LABEL_MUTE, formatColor, mix, parseColor, recolor, type Rgb, type StyleJson } from "./freightMapStyle";

describe("reading a colour", () => {
  it("reads hex, rgb and rgba, commas or spaces", () => {
    expect(parseColor("#fff")).toEqual({ rgb: [255, 255, 255], a: 1 });
    expect(parseColor("#e6e9e5")).toEqual({ rgb: [230, 233, 229], a: 1 });
    expect(parseColor("#00000080")).toEqual({ rgb: [0, 0, 0], a: 0.502 });
    expect(parseColor("rgb(242,243,240)")).toEqual({ rgb: [242, 243, 240], a: 1 });
    expect(parseColor("rgb(27 ,27 ,29)")).toEqual({ rgb: [27, 27, 29], a: 1 });
    expect(parseColor("rgba(60,60,60,0.8)")).toEqual({ rgb: [60, 60, 60], a: 0.8 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ rgb: [10, 20, 30], a: 0.5 });
  });

  it("reads hsl and hsla", () => {
    expect(parseColor("hsl(0,0%,98%)")).toEqual({ rgb: [250, 250, 250], a: 1 });
    expect(parseColor("hsla(0,0%,85%,0.53)")).toEqual({ rgb: [217, 217, 217], a: 0.53 });
    expect(parseColor("hsl(195,17%,78%)")?.rgb).toEqual([189, 204, 208]);
    expect(parseColor("hsl(120, 100%, 25%)")?.rgb).toEqual([0, 128, 0]);
  });

  it("gives null for what is not a colour", () => {
    for (const s of ["linear", "zoom", "interpolate", "", "rgb(1,2)", "#12", "red"]) expect(parseColor(s)).toBeNull();
  });

  it("writes a colour MapLibre reads back the same", () => {
    expect(formatColor([1, 2, 3])).toBe("rgba(1,2,3,1)");
    expect(formatColor([1, 2, 3], 0.8)).toBe("rgba(1,2,3,0.8)");
    expect(parseColor(formatColor([27, 28, 29], 0.53))).toEqual({ rgb: [27, 28, 29], a: 0.53 });
  });

  it("mixes two colours", () => {
    expect(mix([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(mix([10, 10, 10], [20, 20, 20], 0)).toEqual([10, 10, 10]);
  });
});

// A few layers of each OpenFreeMap style, with the colours they really have.
const POSITRON: StyleJson = {
  version: 8,
  layers: [
    { id: "background", type: "background", paint: { "background-color": "rgb(242,243,240)" } },
    { id: "park", type: "fill", "source-layer": "park", paint: { "fill-color": "rgb(230, 233, 229)" } },
    { id: "water", type: "fill", "source-layer": "water", paint: { "fill-antialias": true, "fill-color": "rgb(194, 200, 202)" } },
    { id: "waterway", type: "line", "source-layer": "waterway", paint: { "line-color": "hsl(195,17%,78%)" } },
    { id: "road_pier", type: "line", "source-layer": "transportation", paint: { "line-color": "rgb(242,243,240)" } },
    { id: "highway_major_inner", type: "line", "source-layer": "transportation", paint: { "line-color": "#fff" } },
    { id: "label_city", type: "symbol", "source-layer": "place", paint: { "text-color": "#000", "text-halo-color": "#fff" } },
  ],
};
const DARK: StyleJson = {
  version: 8,
  layers: [
    { id: "background", type: "background", paint: { "background-color": "rgb(12,12,12)" } },
    { id: "water", type: "fill", "source-layer": "water", paint: { "fill-color": "rgb(27 ,27 ,29)" } },
    { id: "road_area_pier", type: "fill", "source-layer": "transportation", paint: { "fill-color": "rgb(12,12,12)" } },
    { id: "highway_minor", type: "line", "source-layer": "transportation", paint: { "line-color": "#181818", "line-opacity": 0.9 } },
    { id: "highway_motorway_inner", type: "line", "source-layer": "transportation", paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5.8, "hsla(0,0%,85%,0.53)", 6, "#000"] } },
    { id: "highway_major_casing", type: "line", "source-layer": "transportation", paint: { "line-color": "rgba(60,60,60,0.8)" } },
    { id: "place_city", type: "symbol", "source-layer": "place", paint: { "text-color": "rgb(101,101,101)", "text-halo-color": "rgba(0,0,0,0.7)" } },
  ],
};
const paint = (s: StyleJson, id: string) => s.layers.find((l) => l.id === id)!.paint!;

const LAND_LIGHT: Rgb = [246, 246, 243], WATER_LIGHT: Rgb = [200, 214, 226];
const LAND_DARK: Rgb = [46, 46, 49], WATER_DARK: Rgb = [40, 52, 66];

describe("the light map", () => {
  const out = recolor(POSITRON, { dark: false, land: LAND_LIGHT, water: WATER_LIGHT });

  it("makes the land the app's surface colour, including the layers drawn in the style's own land colour", () => {
    expect(paint(out, "background")["background-color"]).toBe(formatColor(LAND_LIGHT));
    expect(paint(out, "road_pier")["line-color"]).toBe(formatColor(LAND_LIGHT));
  });

  it("makes the water a quiet blue-grey, sea and rivers alike", () => {
    expect(paint(out, "water")["fill-color"]).toBe(formatColor(WATER_LIGHT));
    expect(paint(out, "waterway")["line-color"]).toBe(formatColor(WATER_LIGHT));
    expect(paint(out, "water")["fill-antialias"]).toBe(true);
  });

  it("leaves roads and parks as the style has them", () => {
    expect(paint(out, "highway_major_inner")["line-color"]).toBe("rgba(255,255,255,1)");
    expect(paint(out, "park")["fill-color"]).toBe("rgba(230,233,229,1)");
  });

  it("quietens a label a little and leaves its halo", () => {
    expect(paint(out, "label_city")["text-color"]).toBe(formatColor(mix([0, 0, 0], LAND_LIGHT, LABEL_MUTE)));
    expect(paint(out, "label_city")["text-halo-color"]).toBe("rgba(255,255,255,1)");
  });
});

describe("the dark map", () => {
  const out = recolor(DARK, { dark: true, land: LAND_DARK, water: WATER_DARK });

  it("lifts the land clear of black", () => {
    const land = parseColor(paint(out, "background")["background-color"] as string)!.rgb;
    expect(land).toEqual(LAND_DARK);
    expect(land.every((v) => v >= 30)).toBe(true);
    expect(paint(out, "road_area_pier")["fill-color"]).toBe(formatColor(LAND_DARK));
  });

  it("moves every other colour up by the same amount, so roads keep their contrast with the ground", () => {
    // The style's land is 12 and its minor roads 24, 12 above it; here they are 12 above the new land too.
    expect(paint(out, "highway_minor")["line-color"]).toBe("rgba(58,58,61,1)");
    expect(paint(out, "highway_minor")["line-opacity"]).toBe(0.9);
    expect(paint(out, "highway_major_casing")["line-color"]).toBe("rgba(94,94,97,0.8)");
  });

  it("moves the colours inside a zoom expression, and nothing else in it", () => {
    expect(paint(out, "highway_motorway_inner")["line-color"]).toEqual([
      "interpolate", ["linear"], ["zoom"], 5.8, "rgba(251,251,254,0.53)", 6, "rgba(34,34,37,1)",
    ]);
  });

  it("keeps water lighter than land and a label readable on it", () => {
    expect(paint(out, "water")["fill-color"]).toBe(formatColor(WATER_DARK));
    const label = parseColor(paint(out, "place_city")["text-color"] as string)!.rgb;
    expect(label[0]).toBeGreaterThan(LAND_DARK[0] + 60);
  });
});

describe("recolor", () => {
  it("does not change the style it is given", () => {
    const before = JSON.stringify(DARK);
    recolor(DARK, { dark: true, land: LAND_DARK, water: WATER_DARK });
    expect(JSON.stringify(DARK)).toBe(before);
  });

  it("sets a label that the style writes in capitals back in the case of the name", () => {
    const caps: StyleJson = {
      version: 8,
      layers: [
        { id: "place_state", type: "symbol", layout: { "text-transform": "uppercase", "text-field": "{name}" }, paint: { "text-color": "#999" } },
        { id: "place_city", type: "symbol", layout: { "text-field": "{name}" } },
      ],
    };
    const out = recolor(caps, { dark: true, land: LAND_DARK, water: WATER_DARK });
    expect(out.layers[0].layout).toEqual({ "text-transform": "none", "text-field": "{name}" });
    expect(out.layers[1].layout).toEqual({ "text-field": "{name}" });
    expect((caps.layers[0].layout as Record<string, string>)["text-transform"]).toBe("uppercase");
  });

  it("copes with a style that has no background layer or no paint", () => {
    const odd: StyleJson = { version: 8, layers: [{ id: "x", type: "symbol" }, { id: "y", type: "line", paint: { "line-color": "#fff" } }] };
    const out = recolor(odd, { dark: true, land: LAND_DARK, water: WATER_DARK });
    expect(out.layers[0]).toEqual({ id: "x", type: "symbol" });
    expect(paint(out, "y")["line-color"]).toBe("rgba(255,255,255,1)");
  });

  it("keeps the style's other keys", () => {
    const out = recolor({ ...POSITRON, glyphs: "https://example.test/{fontstack}/{range}.pbf" }, { dark: false, land: LAND_LIGHT, water: WATER_LIGHT });
    expect(out.glyphs).toBe("https://example.test/{fontstack}/{range}.pbf");
    expect(out.version).toBe(8);
  });
});
