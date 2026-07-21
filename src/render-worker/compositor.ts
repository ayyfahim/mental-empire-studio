import type { GpuRenderSpec } from '@shared/renderSpec'
import { activeImageIndex, introZoomAt, punchEnvelope } from '@shared/renderSpec'
import type { LutTexture } from './lut'

// WebGL2 compositor: one full-screen quad, one fragment shader that applies the whole
// look in a single GPU pass per frame (no readback between effects):
//   base image (+ crossfade) → Ken Burns/punch zoom (UV transform) → colour grade
//   (saturation/contrast/brightness/colour-balance) → vignette → film grain → overlay
//   → caption layer. Output goes to an OffscreenCanvas the encoder wraps in a VideoFrame.

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_imgA;
uniform sampler2D u_imgB;
uniform sampler2D u_caption;
uniform sampler2D u_lut;

uniform float u_mix;          // transition progress A->B (0 = all A)
uniform int   u_transMode;    // transition type (see transitionModeFor)
uniform vec2  u_scaleA;       // ken-burns/punch zoom for A
uniform vec2  u_scaleB;
uniform vec2  u_panA;
uniform vec2  u_panB;
uniform float u_lutSize;
uniform float u_lutStrength;
uniform float u_saturation;
uniform float u_contrast;
uniform float u_brightness;
uniform vec3  u_colorBalance;
uniform float u_vignette;
uniform float u_grain;
uniform float u_grainSeed;
uniform float u_sharpen;
uniform vec2  u_texel;
uniform bool  u_hasLut;
uniform vec4  u_ovEdges;      // edge flags: (top, right, bottom, left), 1 = on
uniform float u_ovIntensity;  // 0–100, 0 = off

vec2 zoomUv(vec2 uv, vec2 scale, vec2 pan) {
  return (uv - 0.5) / scale + 0.5 - pan;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 sampleA(vec2 uv) { return texture(u_imgA, zoomUv(uv, u_scaleA, u_panA)).rgb; }
vec3 sampleB(vec2 uv) { return texture(u_imgB, zoomUv(uv, u_scaleB, u_panB)).rgb; }

// Style/plan transitions, mirroring the ffmpeg xfade types the render path uses:
// 0 fade · 1 fadeblack · 2 fadewhite · 3 slide/wipe-left · 4 slide/wipe-right ·
// 5 slideup · 6 slidedown · 7 zoomin · 8 dissolve/radial · 9 circleopen · 10 circleclose
vec3 baseColor(vec2 uv) {
  float m = clamp(u_mix, 0.0, 1.0);
  if (m <= 0.0) return sampleA(uv);
  if (u_transMode == 1) {
    return m < 0.5 ? sampleA(uv) * (1.0 - m * 2.0) : sampleB(uv) * (m * 2.0 - 1.0);
  } else if (u_transMode == 2) {
    return m < 0.5 ? mix(sampleA(uv), vec3(1.0), m * 2.0) : mix(vec3(1.0), sampleB(uv), m * 2.0 - 1.0);
  } else if (u_transMode >= 3 && u_transMode <= 6) {
    vec2 dir = u_transMode == 3 ? vec2(1.0, 0.0)
             : u_transMode == 4 ? vec2(-1.0, 0.0)
             : u_transMode == 5 ? vec2(0.0, 1.0)
             : vec2(0.0, -1.0);
    float e = m * m * (3.0 - 2.0 * m); // smooth slide
    vec2 uvA = uv + dir * e;
    if (uvA.x >= 0.0 && uvA.x <= 1.0 && uvA.y >= 0.0 && uvA.y <= 1.0) return sampleA(uvA);
    return sampleB(uvA - dir);
  } else if (u_transMode == 7) {
    float z = 1.0 + m * 0.45;
    vec2 uvA = (uv - 0.5) / z + 0.5;
    return mix(sampleA(uvA), sampleB(uv), smoothstep(0.35, 1.0, m));
  } else if (u_transMode == 8) {
    float n = hash(uv * vec2(917.0, 533.0));
    float edge = smoothstep(m - 0.08, m + 0.08, n);
    return mix(sampleB(uv), sampleA(uv), edge);
  } else if (u_transMode == 9) {
    float d = distance(uv, vec2(0.5));
    return mix(sampleA(uv), sampleB(uv), smoothstep(m * 0.78, m * 0.78 - 0.06, d));
  } else if (u_transMode == 10) {
    float d = distance(uv, vec2(0.5));
    return mix(sampleB(uv), sampleA(uv), smoothstep((1.0 - m) * 0.78, (1.0 - m) * 0.78 - 0.06, d));
  }
  return mix(sampleA(uv), sampleB(uv), m);
}

vec3 sampleLut(vec3 rgb) {
  float size = u_lutSize;
  vec3 c = clamp(rgb, 0.0, 1.0);
  float blue = c.b * (size - 1.0);
  float b0 = floor(blue);
  float b1 = min(size - 1.0, b0 + 1.0);
  float f = blue - b0;
  vec2 uv0 = vec2(
    (b0 * size + c.r * (size - 1.0) + 0.5) / (size * size),
    (c.g * (size - 1.0) + 0.5) / size
  );
  vec2 uv1 = vec2(
    (b1 * size + c.r * (size - 1.0) + 0.5) / (size * size),
    (c.g * (size - 1.0) + 0.5) / size
  );
  return mix(texture(u_lut, uv0).rgb, texture(u_lut, uv1).rgb, f);
}

void main() {
  vec3 col = baseColor(v_uv);

  // subtle unsharp mask for the Intense style
  if (u_sharpen > 0.0) {
    vec3 blur = (
      baseColor(v_uv + vec2(u_texel.x, 0.0)) +
      baseColor(v_uv - vec2(u_texel.x, 0.0)) +
      baseColor(v_uv + vec2(0.0, u_texel.y)) +
      baseColor(v_uv - vec2(0.0, u_texel.y))
    ) * 0.25;
    col = mix(col, col + (col - blur), clamp(u_sharpen, 0.0, 1.0));
  }

  // colour balance (lift per channel)
  col += u_colorBalance;

  // saturation
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, u_saturation);

  // contrast + brightness
  col = (col - 0.5) * u_contrast + 0.5 + u_brightness;

  // vignette
  if (u_vignette > 0.0) {
    float d = distance(v_uv, vec2(0.5));
    float vig = smoothstep(0.8, 0.2, d * (1.0 + u_vignette));
    col *= mix(1.0, vig, u_vignette);
  }

  // film grain
  if (u_grain > 0.0) {
    float n = hash(v_uv * vec2(1920.0, 1080.0) + u_grainSeed) - 0.5;
    col += n * u_grain;
  }

  col = clamp(col, 0.0, 1.0);

  if (u_hasLut && u_lutStrength > 0.0 && u_lutSize > 1.0) {
    col = mix(col, sampleLut(col), clamp(u_lutStrength, 0.0, 1.0));
  }

  // edge-gradient darkening overlay — computed in-shader to match overlayAlphaAt()
  // (renderSpec.ts): extent 0.12–0.60, max alpha 0–200/255, eased by pow(ramp, 1.7).
  if (u_ovIntensity > 0.0) {
    float extentRatio = 0.12 + (u_ovIntensity / 100.0) * 0.48;
    float maxAlpha = (u_ovIntensity / 100.0) * 200.0 / 255.0;
    float rTop    = u_ovEdges.x > 0.5 ? (extentRatio - v_uv.y) / extentRatio : 0.0;
    float rRight  = u_ovEdges.y > 0.5 ? (v_uv.x - (1.0 - extentRatio)) / extentRatio : 0.0;
    float rBottom = u_ovEdges.z > 0.5 ? (v_uv.y - (1.0 - extentRatio)) / extentRatio : 0.0;
    float rLeft   = u_ovEdges.w > 0.5 ? (extentRatio - v_uv.x) / extentRatio : 0.0;
    float ramp = clamp(max(max(rTop, rRight), max(rBottom, rLeft)), 0.0, 1.0);
    col = mix(col, vec3(0.0), maxAlpha * pow(ramp, 1.7));
  }

  // captions on top
  vec4 cap = texture(u_caption, v_uv);
  col = mix(col, cap.rgb, cap.a);

  fragColor = vec4(col, 1.0);
}`

/** Map an ffmpeg xfade transition name onto the shader's mode int. Unknown names
 *  degrade to a plain crossfade rather than failing. */
export function transitionModeFor(type: string): number {
  switch (type) {
    case 'fadeblack': return 1
    case 'fadewhite': return 2
    case 'wipeleft':
    case 'smoothleft': return 3
    case 'wiperight':
    case 'smoothright': return 4
    case 'slideup': return 5
    case 'slidedown': return 6
    case 'zoomin': return 7
    case 'dissolve':
    case 'radial': return 8
    case 'circleopen': return 9
    case 'circleclose': return 10
    default: return 0
  }
}

/** B-roll is decoded one segment at a time, so no next-video texture exists for a
 * dissolve. Keep those boundaries as hard cuts; still-image transitions retain the
 * requested blend. Exported to make this black-frame regression unit-testable. */
export function transitionProgressFor(
  isBroll: boolean,
  hasNext: boolean,
  remainSec: number,
  durationSec: number
): number {
  if (isBroll || !hasNext || remainSec >= durationSec) return 0
  return Math.min(1, Math.max(0, (durationSec - remainSec) / durationSec))
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`shader compile failed: ${log}`)
  }
  return sh
}

export class Compositor {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vs: WebGLShader
  private fs: WebGLShader
  private buffer: WebGLBuffer
  private imgTextures: WebGLTexture[] = []
  private lutTex: WebGLTexture | null = null
  private lutSize = 0
  private captionTex: WebGLTexture
  private videoTexA: WebGLTexture
  private videoTexB: WebGLTexture
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private disposed = false

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas, private spec: GpuRenderSpec) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL2 unavailable in render worker')
    this.gl = gl

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    this.vs = vs
    this.fs = fs
    const program = gl.createProgram()
    if (!program) throw new Error('createProgram failed')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    this.program = program
    gl.useProgram(program)

    // Full-screen triangle pair.
    const buf = gl.createBuffer()
    if (!buf) throw new Error('createBuffer failed')
    this.buffer = buf
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    for (const name of ['u_imgA', 'u_imgB', 'u_caption', 'u_lut', 'u_mix', 'u_transMode', 'u_scaleA', 'u_scaleB', 'u_panA', 'u_panB', 'u_lutSize', 'u_lutStrength', 'u_saturation', 'u_contrast', 'u_brightness', 'u_colorBalance', 'u_vignette', 'u_grain', 'u_grainSeed', 'u_sharpen', 'u_texel', 'u_hasLut', 'u_ovEdges', 'u_ovIntensity']) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }

    this.captionTex = this.newTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.captionTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))

    this.videoTexA = this.newTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexA)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))

    this.videoTexB = this.newTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexB)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('createTexture failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex
  }

  /** Upload the slideshow stills as textures. Frees any previously-uploaded image
   *  textures first — callers may invoke this repeatedly as the image set changes. */
  setImages(bitmaps: ImageBitmap[]): void {
    const gl = this.gl
    this.imgTextures.forEach((t) => gl.deleteTexture(t))
    this.imgTextures = bitmaps.map((bmp) => {
      const tex = this.newTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
      return tex
    })
    // Guarantee at least one texture so the shader always has a bound sampler.
    if (this.imgTextures.length === 0) {
      const tex = this.newTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([17, 19, 22, 255]))
      this.imgTextures = [tex]
    }
  }

  setLut(lut: LutTexture | null): void {
    const gl = this.gl
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    this.lutTex = null
    this.lutSize = 0
    if (!lut) return
    this.lutTex = this.newTexture()
    this.lutSize = lut.size
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.width, lut.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data)
  }

  /** Re-upload the caption canvas (only when it changed). */
  updateCaption(source: OffscreenCanvas): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.captionTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  }

  /** Swap the spec reference in-place (for motion/grain changes that don't need a full rebuild). */
  updateSpec(spec: GpuRenderSpec): void {
    this.spec = spec
  }

  /** Upload decoded B-roll frames directly as textures. */
  updateVideoTextures(frameA: VideoFrame | null, frameB: VideoFrame | null): void {
    const gl = this.gl
    if (frameA) {
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexA)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameA)
    }
    if (frameB) {
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexB)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameB)
    }
  }

  private ease(p: number, ease?: string): number {
    const t = Math.min(1, Math.max(0, p))
    if (ease === 'easeInOutCubic') return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    return t
  }

  /** Ken Burns / punch zoom transform for the image at index i at time t. */
  private transformAt(i: number, timeSec: number): [number, number, number, number] {
    let s = 1
    let panX = 0
    let panY = 0
    const isBroll = this.spec.broll && this.spec.broll.length > 0
    const img = isBroll ? null : this.spec.images[i]
    if (this.spec.motion.kenBurns && img) {
      const span = Math.max(0.5, img.endSec - img.startSec)
      const p = Math.min(1, Math.max(0, (timeSec - img.startSec) / span))
      if (img.motion) {
        const e = this.ease(p, img.motion.ease)
        s = img.motion.zoomFrom + (img.motion.zoomTo - img.motion.zoomFrom) * e
        panX = img.motion.panX * e
        panY = img.motion.panY * e
      } else {
        s = 1 + 0.12 * p
      }
    }
    // Punch pulses (already rate-limited in the spec) + the intro push-in. Same
    // envelope curves as the ffmpeg expression (shared/renderSpec.ts).
    for (const at of this.spec.motion.punchAtSec) {
      const env = punchEnvelope(timeSec, at)
      if (env > 0) s *= 1 + 0.07 * env
    }
    if (this.spec.motion.introZoom) s *= introZoomAt(timeSec)
    return [s, s, panX, panY]
  }

  /** Transition to use at a segment boundary: the nearest planned transition within
   *  tolerance, else the style/default fallback (mirrors render.ts transitionAt). */
  private transitionFor(boundarySec: number): { mode: number; dur: number } {
    let best: { type: string; dur: number } | null = null
    let bestDist = 1.6
    for (const t of this.spec.transitions ?? []) {
      const d = Math.abs(t.atSec - boundarySec)
      if (d < bestDist) { bestDist = d; best = { type: t.type, dur: t.durationSec } }
    }
    const fallback = this.spec.defaultTransition ?? { type: 'fade', durationSec: 0.4 }
    const chosen = best ?? { type: fallback.type, dur: fallback.durationSec }
    return { mode: transitionModeFor(chosen.type), dur: Math.max(0, Math.min(1, chosen.dur)) }
  }

  /** Draw one frame at time `t`. Assumes updateCaption() already ran for this frame. */
  drawFrame(timeSec: number): void {
    if (this.disposed) return
    const gl = this.gl
    const g = this.spec.grade

    const isBroll = !!(this.spec.broll && this.spec.broll.length > 0)
    const activeSegs = isBroll ? this.spec.broll! : this.spec.images
    const idx = activeSegs.length ? activeImageIndex(activeSegs as any, timeSec) : 0
    const nextIdx = Math.min(idx + 1, Math.max(0, activeSegs.length - 1))

    // Transition over the tail of the current segment when a next segment exists. The
    // type/duration come from the effect plan / style default, matching the ffmpeg path.
    let mix = 0
    let transMode = 0
    const seg = activeSegs[idx]
    if (seg && nextIdx !== idx) {
      const tr = this.transitionFor(seg.endSec)
      const remain = seg.endSec - timeSec
      mix = transitionProgressFor(isBroll, true, remain, tr.dur)
      if (mix > 0) {
        transMode = tr.mode
      }
    }

    const textureA = isBroll ? this.videoTexA : this.imgTextures[Math.min(idx, this.imgTextures.length - 1)]
    const textureB = isBroll ? this.videoTexA : this.imgTextures[nextIdx]

    gl.useProgram(this.program)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, textureA)
    gl.uniform1i(this.uniforms.u_imgA, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, textureB)
    gl.uniform1i(this.uniforms.u_imgB, 1)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.captionTex)
    gl.uniform1i(this.uniforms.u_caption, 3)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex ?? (this.imgTextures.length ? this.imgTextures[0] : this.videoTexA))
    gl.uniform1i(this.uniforms.u_lut, 4)

    const [sax, say, pax, pay] = this.transformAt(idx, timeSec)
    const [sbx, sby, pbx, pby] = this.transformAt(nextIdx, timeSec)
    const lutStrength = g.lut ? (g.lutStrength ?? 1) : 0
    gl.uniform1f(this.uniforms.u_mix, mix)
    gl.uniform1i(this.uniforms.u_transMode, transMode)
    gl.uniform2f(this.uniforms.u_scaleA, sax, say)
    gl.uniform2f(this.uniforms.u_scaleB, sbx, sby)
    gl.uniform2f(this.uniforms.u_panA, pax, pay)
    gl.uniform2f(this.uniforms.u_panB, pbx, pby)
    gl.uniform1f(this.uniforms.u_lutSize, this.lutSize)
    gl.uniform1f(this.uniforms.u_lutStrength, lutStrength)
    gl.uniform1f(this.uniforms.u_saturation, g.saturation)
    gl.uniform1f(this.uniforms.u_contrast, g.contrast)
    gl.uniform1f(this.uniforms.u_brightness, g.brightness)
    gl.uniform3f(this.uniforms.u_colorBalance, g.colorBalance.r, g.colorBalance.g, g.colorBalance.b)
    gl.uniform1f(this.uniforms.u_vignette, g.vignette)
    gl.uniform1f(this.uniforms.u_grain, this.spec.grain.strength)
    gl.uniform1f(this.uniforms.u_grainSeed, this.spec.grain.temporal ? (timeSec * this.spec.fps) % 4096 : 1)
    gl.uniform1f(this.uniforms.u_sharpen, g.sharpen)
    gl.uniform2f(this.uniforms.u_texel, 1 / this.canvas.width, 1 / this.canvas.height)
    gl.uniform1i(this.uniforms.u_hasLut, this.lutTex && lutStrength > 0 ? 1 : 0)
    const ov = this.spec.overlay
    gl.uniform4f(this.uniforms.u_ovEdges, ov?.top ? 1 : 0, ov?.right ? 1 : 0, ov?.bottom ? 1 : 0, ov?.left ? 1 : 0)
    gl.uniform1f(this.uniforms.u_ovIntensity, ov ? Math.max(0, Math.min(100, ov.intensity)) : 0)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /** Free every GPU resource this compositor owns. The canvas's WebGL2 context is left
   *  intact (contexts are per-canvas and reused by the next Compositor on the same canvas). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    this.imgTextures.forEach((t) => gl.deleteTexture(t))
    this.imgTextures = []
    if (this.lutTex) gl.deleteTexture(this.lutTex)
    this.lutTex = null
    gl.deleteTexture(this.captionTex)
    gl.deleteTexture(this.videoTexA)
    gl.deleteTexture(this.videoTexB)
    gl.deleteBuffer(this.buffer)
    gl.deleteProgram(this.program)
    gl.deleteShader(this.vs)
    gl.deleteShader(this.fs)
  }
}
