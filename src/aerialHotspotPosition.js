// North-up extracts use a centered 3:2 footprint, with width measured in meters.
export function imageToOffset(x, y, width) {
  return { east: (x - 0.5) * width, north: (0.5 - y) * width * 2 / 3 };
}

export function offsetToImage({ east, north }, width) {
  return { x: 0.5 + east / width, y: 0.5 - north / (width * 2 / 3) };
}
