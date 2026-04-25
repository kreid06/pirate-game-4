#version 300 es
precision mediump float;

// Full-screen quad: clip-space positions, no MVP needed.
// Two triangles covering NDC [-1,1]×[-1,1].
layout(location = 0) in vec2 a_clipPos;

// Camera uniforms — used to reconstruct world-space position in fragment shader
uniform vec2  u_cameraPos;   // world-space camera centre
uniform float u_zoom;        // pixels per world unit (1.0 = no zoom)
uniform vec2  u_resolution;  // viewport size in pixels

out vec2 v_worldPos;

void main() {
  gl_Position = vec4(a_clipPos, 0.0, 1.0);

  // Reconstruct world position for this fragment
  // NDC → pixel → world
  vec2 ndc = a_clipPos;                             // -1..1
  vec2 pixel = (ndc * 0.5 + 0.5) * u_resolution;  // 0..res
  v_worldPos = u_cameraPos + (pixel - u_resolution * 0.5) / u_zoom;
}
