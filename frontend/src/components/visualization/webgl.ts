let supported: boolean | null = null;

/**
 * Whether this browser can create a WebGL context. Checked once, before the
 * 3D scene's code is downloaded: without WebGL it never is.
 */
export function webglAvailable(): boolean {
  if (supported !== null) return supported;
  try {
    const canvas = document.createElement("canvas");
    supported = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    supported = false;
  }
  return supported;
}

/** Tests only: forget the cached answer. */
export function resetWebglCheck() {
  supported = null;
}
