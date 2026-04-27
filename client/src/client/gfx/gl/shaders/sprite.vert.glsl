#version 300 es
precision mediump float;

// Per-vertex: a unit quad [0,1]×[0,1]
layout(location = 0) in vec2 a_quad;

// Per-instance (divisor = 1)
layout(location = 1) in vec2  a_pos;       // world position (centre)
layout(location = 2) in vec2  a_size;      // world size (w, h)
layout(location = 3) in float a_angle;     // rotation in radians
layout(location = 4) in vec4  a_uvRect;    // (u0, v0, u1, v1)
layout(location = 5) in vec4  a_tint;      // premultiplied RGBA

uniform mat4 u_viewProj;

out vec2 v_uv;
out vec4 v_tint;

void main() {
  // Build local-space quad centred at origin
  vec2 local = (a_quad - 0.5) * a_size;

  // Rotate
  float s = sin(a_angle);
  float c = cos(a_angle);
  vec2 rot = vec2(c * local.x - s * local.y,
                  s * local.x + c * local.y);

  // World position
  vec4 worldPos = vec4(rot + a_pos, 0.0, 1.0);
  gl_Position = u_viewProj * worldPos;

  // UV within the atlas rect
  v_uv   = a_uvRect.xy + a_quad * (a_uvRect.zw - a_uvRect.xy);
  v_tint = a_tint;
}
