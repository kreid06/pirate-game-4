/**
 * Heuristic detection of GPU vs software WebGL rendering.
 *
 * Browsers do not expose a "hardware acceleration enabled" flag to JS.
 * We infer likely software rendering from the unmasked WebGL renderer string
 * (SwiftShader, LLVMpipe, etc.) or total WebGL failure.
 */

export type GraphicsBackendKind =
  | 'webgl2-gpu'
  | 'webgl2-software'
  | 'webgl2-unknown'
  | 'webgl-gpu'
  | 'webgl-software'
  | 'webgl-unknown'
  | 'canvas2d-only';

export interface GraphicsBackendReport {
  /** Best guess at the active rendering path. */
  kind: GraphicsBackendKind;
  webgl2Available: boolean;
  webgl1Available: boolean;
  /** True when the game successfully created its WebGL2 world renderer. */
  webgl2Active: boolean;
  vendor: string | null;
  renderer: string | null;
  /** Renderer string matches known software backends (SwiftShader, etc.). */
  likelySoftwareRenderer: boolean;
  /** WebGL missing or software renderer — user should check browser GPU settings. */
  hardwareAccelerationLikelyDisabled: boolean;
  /** Non-null when the player should see an in-game warning banner. */
  warningMessage: string | null;
}

const SOFTWARE_RENDERER_RE =
  /swiftshader|llvmpipe|software|microsoft basic|mesa offscreen|virgl|softpipe|lavapipe/i;

function probeWebGL(preferWebGL2: boolean): {
  gl: WebGL2RenderingContext | WebGLRenderingContext;
  isWebGL2: boolean;
  vendor: string | null;
  renderer: string | null;
} | null {
  const canvas = document.createElement('canvas');
  const gl2 = preferWebGL2
    ? (canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null)
    : null;
  const gl1 = gl2 ?? (canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false }) as WebGLRenderingContext | null);
  const gl = gl2 ?? gl1;
  if (!gl) return null;

  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext) {
    return { gl, isWebGL2: !!gl2, vendor: null, renderer: null };
  }

  return {
    gl,
    isWebGL2: !!gl2,
    vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string,
    renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string,
  };
}

function rendererLooksSoftware(vendor: string | null, renderer: string | null): boolean {
  const blob = `${vendor ?? ''} ${renderer ?? ''}`;
  if (!blob.trim()) return false;
  return SOFTWARE_RENDERER_RE.test(blob);
}

function classifyKind(
  webgl2Active: boolean,
  probe: ReturnType<typeof probeWebGL>,
  software: boolean,
): GraphicsBackendKind {
  if (webgl2Active) {
    if (software) return 'webgl2-software';
    if (probe?.renderer) return 'webgl2-gpu';
    return 'webgl2-unknown';
  }
  if (!probe) return 'canvas2d-only';
  if (software) return probe.isWebGL2 ? 'webgl2-software' : 'webgl-software';
  if (probe.renderer) return probe.isWebGL2 ? 'webgl2-gpu' : 'webgl-gpu';
  return probe.isWebGL2 ? 'webgl2-unknown' : 'webgl-unknown';
}

function buildWarning(
  kind: GraphicsBackendKind,
  webgl2Active: boolean,
  software: boolean,
  webglAvailable: boolean,
): string | null {
  if (!webglAvailable) {
    return 'WebGL is unavailable — enable hardware acceleration in your browser settings for better performance.';
  }
  if (software) {
    return 'Graphics are using a software renderer — enable hardware acceleration in browser settings.';
  }
  if (!webgl2Active && kind === 'canvas2d-only') {
    return 'WebGL2 unavailable — running Canvas 2D fallback. Enable hardware acceleration for better performance.';
  }
  return null;
}

/**
 * Probe the browser graphics stack once at startup.
 * @param webgl2Active Whether ClientApplication successfully created GLContext.
 */
export function detectGraphicsBackend(webgl2Active: boolean): GraphicsBackendReport {
  const probe2 = probeWebGL(true);
  const probe1 = probe2 ? null : probeWebGL(false);
  const probe = probe2 ?? probe1;

  const webgl2Available = !!probe2;
  const webgl1Available = !!probe1 || !!probe2;
  const vendor = probe?.vendor ?? null;
  const renderer = probe?.renderer ?? null;
  const likelySoftwareRenderer = rendererLooksSoftware(vendor, renderer);
  const webglAvailable = webgl2Available || webgl1Available;

  const kind = classifyKind(webgl2Active, probe, likelySoftwareRenderer);
  const hardwareAccelerationLikelyDisabled =
    !webglAvailable || likelySoftwareRenderer;

  const warningMessage = buildWarning(kind, webgl2Active, likelySoftwareRenderer, webglAvailable);

  return {
    kind,
    webgl2Available,
    webgl1Available,
    webgl2Active,
    vendor,
    renderer,
    likelySoftwareRenderer,
    hardwareAccelerationLikelyDisabled,
    warningMessage,
  };
}

/** Structured console log for support / debugging. */
export function logGraphicsBackendReport(report: GraphicsBackendReport): void {
  const tag = report.hardwareAccelerationLikelyDisabled ? 'warn' : 'log';
  const lines = [
    `[Graphics] backend=${report.kind}`,
    `webgl2=${report.webgl2Available ? 'yes' : 'no'} active=${report.webgl2Active ? 'yes' : 'no'}`,
    report.vendor ? `vendor=${report.vendor}` : 'vendor=(blocked)',
    report.renderer ? `renderer=${report.renderer}` : 'renderer=(blocked)',
    `software=${report.likelySoftwareRenderer ? 'likely' : 'no'}`,
  ];
  console[tag](lines.join(' | '));
}
