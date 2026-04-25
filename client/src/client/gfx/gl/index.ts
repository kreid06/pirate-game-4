/**
 * GL subsystem public API — re-export everything for clean imports.
 *
 *   import { GLContext, SpriteBatcher, TextureManager } from '../gfx/gl/index.js';
 */

export { GLContext }                          from './GLContext.js';
export type { GLCapabilities }               from './GLContext.js';

export { ShaderProgram }                     from './ShaderProgram.js';

export { GpuBuffer, QuadIndexBuffer,
         applyVertexLayout, disableVertexLayout } from './BufferPool.js';
export type { AttribDesc }                   from './BufferPool.js';

export { TextureManager }                    from './TextureManager.js';
export type { TextureEntry }                 from './TextureManager.js';

export { SpriteBatcher, MAX_SPRITES_PER_BATCH } from './SpriteBatcher.js';
export type { SpriteSubmit }                 from './SpriteBatcher.js';

export { SpriteAtlas }                       from './SpriteAtlas.js';
export type { UVRect }                       from './SpriteAtlas.js';

export { OceanRenderer }                     from './OceanRenderer.js';
