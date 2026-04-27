/**
 * ShaderProgram — compile, link, and cache GLSL uniform locations.
 *
 * Usage:
 *   const prog = ShaderProgram.create(gl, vertSrc, fragSrc);
 *   prog.use();
 *   prog.setUniform1i('u_texture', 0);
 *   prog.setUniformMat4('u_mvp', matrix);
 */
export class ShaderProgram {
  public readonly program: WebGLProgram;
  private readonly _gl: WebGL2RenderingContext;
  private readonly _uniforms = new Map<string, WebGLUniformLocation>();

  private constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {
    this._gl      = gl;
    this.program  = program;
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  static create(
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    label = 'shader',
  ): ShaderProgram {
    const vert = ShaderProgram._compile(gl, gl.VERTEX_SHADER,   vertSrc, label + '.vert');
    const frag = ShaderProgram._compile(gl, gl.FRAGMENT_SHADER, fragSrc, label + '.frag');

    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    // Shaders are linked — detach and delete the intermediate objects
    gl.detachShader(program, vert);
    gl.detachShader(program, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`[GL] Shader link failed (${label}): ${log}`);
    }

    console.log(`[GL] Shader program linked: ${label}`);
    return new ShaderProgram(gl, program);
  }

  // ── Usage ─────────────────────────────────────────────────────────────────

  use(): void {
    this._gl.useProgram(this.program);
  }

  dispose(): void {
    this._gl.deleteProgram(this.program);
  }

  // ── Uniform setters ───────────────────────────────────────────────────────

  setUniform1i(name: string, v: number): void {
    this._gl.uniform1i(this._loc(name), v);
  }

  setUniform1f(name: string, v: number): void {
    this._gl.uniform1f(this._loc(name), v);
  }

  setUniform2f(name: string, x: number, y: number): void {
    this._gl.uniform2f(this._loc(name), x, y);
  }

  setUniform4f(name: string, x: number, y: number, z: number, w: number): void {
    this._gl.uniform4f(this._loc(name), x, y, z, w);
  }

  setUniformMat4(name: string, mat: Float32Array): void {
    this._gl.uniformMatrix4fv(this._loc(name), false, mat);
  }

  // ── Attribute helpers ─────────────────────────────────────────────────────

  attribLocation(name: string): number {
    return this._gl.getAttribLocation(this.program, name);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _loc(name: string): WebGLUniformLocation | null {
    let loc = this._uniforms.get(name);
    if (loc === undefined) {
      const found = this._gl.getUniformLocation(this.program, name);
      if (found === null) {
        // Silently ignore — uniform may be optimised out by the driver
        return null;
      }
      loc = found;
      this._uniforms.set(name, loc);
    }
    return loc;
  }

  private static _compile(
    gl: WebGL2RenderingContext,
    type: number,
    src: string,
    label: string,
  ): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[GL] Shader compile error (${label}):\n${log}`);
    }
    return shader;
  }
}
