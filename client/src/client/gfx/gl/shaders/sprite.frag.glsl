#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_tint;

uniform sampler2D u_texture;

out vec4 fragColor;

void main() {
  vec4 sample = texture(u_texture, v_uv);
  // Premultiplied alpha composite with tint
  fragColor = sample * v_tint;
}
