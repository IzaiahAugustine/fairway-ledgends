// Aerial perspective as a post pass: reconstructs world positions from the depth buffer and
// applies exponential height fog whose colour is the sky's own horizon radiance, warmed and
// brightened toward the sun. Sky pixels get a matching horizon haze so land and sky meet softly.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export interface AtmosphereParams {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  /** Extinction per metre at the base height. */
  density: number;
  /** Exponential falloff with height (1 / scale height). */
  falloff: number;
  baseHeight: number;
  skyHaze: number;
}

export class AtmospherePass extends Pass {
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;

  constructor(private camera: THREE.PerspectiveCamera, depthTexture: THREE.DepthTexture) {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: depthTexture },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uFogCol: { value: new THREE.Color(0.6, 0.7, 0.8) },
        uDensity: { value: 0.0003 },
        uFalloff: { value: 0.0025 },
        uBase: { value: 0 },
        uSkyHaze: { value: 0.5 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tDepth;
        uniform mat4 uProjInv, uCamWorld;
        uniform vec3 uCamPos, uSunDir, uSunCol, uFogCol;
        uniform float uDensity, uFalloff, uBase, uSkyHaze;
        varying vec2 vUv;
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          float depth = texture2D(tDepth, vUv).x;
          vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vp /= vp.w;
          vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
          vec3 ray = wp - uCamPos;
          float dist = length(ray);
          vec3 rd = ray / max(dist, 1e-4);
          float mu = max(dot(rd, uSunDir), 0.0);
          vec3 scatter = uFogCol * (1.0 + 0.35 * pow(mu, 6.0)) + uSunCol * (pow(mu, 10.0) * 0.12 + pow(mu, 60.0) * 0.25);
          if (depth >= 0.999999) {
            float k = exp(-max(rd.y, 0.0) * 18.0) * uSkyHaze;
            col.rgb = mix(col.rgb, scatter, k);
          } else {
            float h0 = max(uCamPos.y - uBase, -50.0);
            float ry = rd.y * dist;
            float a = uDensity * exp(-uFalloff * h0);
            float amt = abs(ry) > 0.01 ? a * (1.0 - exp(-uFalloff * ry)) / (uFalloff * rd.y) : a * dist;
            float T = exp(-max(amt, 0.0));
            col.rgb = mix(scatter, col.rgb, T);
          }
          gl_FragColor = col;
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setParams(p: AtmosphereParams) {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(p.sunDir).normalize();
    u.uSunCol.value.copy(p.sunColor);
    u.uFogCol.value.copy(p.horizon);
    u.uDensity.value = p.density;
    u.uFalloff.value = p.falloff;
    u.uBase.value = p.baseHeight;
    u.uSkyHaze.value = p.skyHaze;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    this.camera.updateMatrixWorld();
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(this.camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
