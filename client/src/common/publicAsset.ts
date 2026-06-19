/**
 * Resolve a path under Vite's `public/` directory for dev and production.
 *
 * Drop files in `client/public/` (e.g. `client/public/items/sword.png`) and load
 * them with `publicAsset('items/sword.png')`. Vite copies public/ into dist/ on
 * build; BASE_URL handles GitHub Pages subpaths like /pirate-game-4/.
 */
export function publicAsset(relativePath: string): string {
  const base = import.meta.env.BASE_URL;
  const path = relativePath.replace(/^\//, '');
  return `${base}${path}`;
}
