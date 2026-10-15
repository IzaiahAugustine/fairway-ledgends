// What kind of device the game runs on.

/** A phone or tablet: the main pointer is a finger. These get lighter assets (less memory). */
export const isTouchDevice = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * Where to load an image or model from. Phones use the smaller copies under m/ (built by
 * blender/mobile_assets.py): mobile Safari keeps an extra full-size copy of every image a page
 * uploads to WebGL, and the full-size set ran past the iPhone's memory limit.
 */
export function assetUrl(path: string): string {
  return isTouchDevice ? `m/${path}` : path;
}

/**
 * A game-portal build (Poki, CrazyGames): they reject games that download more than ~50 MB before
 * play starts, so these load the 2K skies and never the 2K terrain textures.
 */
export const portalBuild = !!import.meta.env.VITE_PORTAL;
