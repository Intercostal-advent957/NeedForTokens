/**
 * Starting-tier regression test for `Settings.detect`.
 *
 * This exists because the tier a machine starts at is invisible on the machine you develop on —
 * an M4 Pro resolves to `high` whether the logic is right or wrong, so a bad rule here ships
 * silently and only ever hurts someone else. Every string below is a real
 * WEBGL_debug_renderer_info value; note that on Windows *every* browser reports through ANGLE,
 * which is why an unrecognised string has to fall back to a safe tier rather than a flattering
 * one.
 *
 *   node tools/gputiers.mjs        # non-zero exit on any mismatch
 */
import { Settings } from '../src/core/Settings.js';

const fake = (desc) => ({
  getContext: () => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
    getParameter: () => desc,
  }),
});

const CASES = [
  // --- Windows, Chrome/Edge: everything is wrapped by ANGLE ---
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 960 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],

  // Arc is discrete but shares Intel's vendor name with the integrated parts above, and the
  // "(TM)" between "Arc" and the model number is what makes the pattern awkward.
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A380 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],

  // --- software rasterisers ---
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'low'],
  ['Microsoft Basic Render Driver', 'low'],

  // --- macOS, i.e. the machine this game was developed and benchmarked on ---
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)', 'high'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'high'],

  // --- mobile ---
  ['ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', 'low'],
  ['Mali-G78 MP14', 'low'],

  // --- unknown or masked: must be the safe tier, never the flattering one ---
  ['', 'medium'],
  ['WebKit WebGL', 'medium'],
];

let failed = 0;
for (const [desc, want] of CASES) {
  const got = Settings.detect(fake(desc));
  if (got !== want) failed++;
  console.log(
    `${got === want ? 'ok  ' : 'FAIL'}  ${want.padEnd(6)}` +
      `${got === want ? '' : `(got ${got}) `}${desc || '(empty)'}`
  );
}

console.log(failed ? `\n${failed}/${CASES.length} FAILED` : `\nall ${CASES.length} passed`);
process.exit(failed ? 1 : 0);
