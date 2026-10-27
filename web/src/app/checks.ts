// What this browser and this page need before the game can start, each with
// a message that says what to do when it is missing.  The start page shows
// only the ones that fail or warn.

export type CheckState = 'pending' | 'ok' | 'warn' | 'fail';
export interface Check { id: string; label: string; state: CheckState; detail: string }

export const MIN_CHROME = 140;
/** Atomics.waitAsync (the renderer's and the network's doorbells) is in Firefox from 145 */
export const MIN_FIREFOX = 145;

/** "Google Chrome" major version, or null (another browser), from User-Agent Client Hints. */
export function chromeVersion(): { brand: string; major: number } | null {
  const uad = (navigator as any).userAgentData as { brands?: { brand: string; version: string }[] } | undefined;
  const b = uad?.brands?.find(x => x.brand === 'Google Chrome') ?? uad?.brands?.find(x => x.brand === 'Chromium');
  if (b) return { brand: b.brand, major: parseInt(b.version, 10) };
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m ? { brand: 'Chromium', major: +m[1] } : null;
}

/** Firefox's major version, or null (another browser; Firefox on iOS is WebKit and says FxiOS). */
export function firefoxVersion(): number | null {
  const m = /Firefox\/(\d+)/.exec(navigator.userAgent);
  return m ? +m[1] : null;
}

/** what the messages call this browser: Firefox, Chrome (any Chromium browser) or the browser */
export function browserName(): string {
  return firefoxVersion() !== null ? 'Firefox' : chromeVersion() ? 'Chrome' : 'the browser';
}
const upper = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Which browser this is: a warning at most, never a reason to stop.  What the
 * game needs is checked by what it is (WebGPU, isolation, storage below), so
 * another browser that has all of it may play.
 */
export function checkBrowser(): Check {
  const f = firefoxVersion();
  if (f !== null) {
    if (f < MIN_FIREFOX) return { id: 'browser', label: `Firefox ${f}`, state: 'warn', detail: `Only the latest Firefox is tested (${MIN_FIREFOX} or newer). Update Firefox (Help, About Firefox) if something does not work.` };
    return { id: 'browser', label: `Firefox ${f}`, state: 'ok', detail: 'A tested browser.' };
  }
  const c = chromeVersion();
  const label = 'Browser';
  if (!c) return { id: 'browser', label, state: 'warn', detail: 'Only Google Chrome and Firefox are tested. This browser may work if every other check passes.' };
  if (c.major < MIN_CHROME) return { id: 'browser', label: `Chrome ${c.major}`, state: 'warn', detail: `Only the latest Chrome is tested (${MIN_CHROME} or newer). Update Chrome (Help, About Google Chrome) if something does not work.` };
  if (c.brand !== 'Google Chrome') return { id: 'browser', label: `${c.brand} ${c.major}`, state: 'warn', detail: 'Only Google Chrome and Firefox are tested. This browser may work if every other check passes.' };
  return { id: 'browser', label: `Chrome ${c.major}`, state: 'ok', detail: 'A tested browser.' };
}

export function checkIsolation(): Check {
  const label = 'Secure, isolated page';
  if (!isSecureContext) {
    return { id: 'isolation', label, state: 'fail',
      detail: `This address is not secure, so ${browserName()} turns off what the game needs. Open the server's https:// address instead.` };
  }
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    return { id: 'isolation', label, state: 'fail', detail: 'The page is not cross-origin isolated (no SharedArrayBuffer). Open it from the server of this port (./run.sh); if it still fails here and works in a private window, clear the service worker of this site (DevTools > Application), not its data: that holds the saves.' };
  }
  try { new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }); }
  catch (e) { return { id: 'isolation', label, state: 'fail', detail: `Shared 4 GB WebAssembly memory is not available: ${e}` }; }
  if (typeof (Atomics as { waitAsync?: unknown }).waitAsync !== 'function') {
    return { id: 'isolation', label, state: 'fail', detail: `This browser is too old for the game (no Atomics.waitAsync). Update ${browserName()}.` };
  }
  return { id: 'isolation', label, state: 'ok', detail: 'HTTPS or localhost, cross-origin isolated, threads and 4 GB memory available.' };
}

export async function checkGpu(): Promise<Check & { adapter?: string }> {
  const label = 'WebGPU';
  const gpu = (navigator as any).gpu as GPU | undefined;
  const ff = firefoxVersion() !== null;
  if (!gpu) return { id: 'gpu', label, state: 'fail', detail: ff
    ? 'WebGPU is off in this Firefox. Update Firefox (it has WebGPU on Windows and macOS); where it is still off, as on Linux and Android, set dom.webgpu.enabled to true in about:config, or play in Chrome.'
    : 'WebGPU is off in this browser. Update Chrome; on Linux enable it in chrome://flags (#enable-unsafe-webgpu).' };
  let ad: GPUAdapter | null = null;
  try { ad = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* reported below */ }
  // Chrome on Linux runs WebGPU on Vulkan while the rest of it stays on OpenGL, so
  // chrome://gpu says WebGPU is on even when no Vulkan driver is installed
  const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  // and on Windows on Direct3D 12 only: the D3D11 adapters are compatibility mode, blocklisted
  const windows = /Windows/.test(navigator.userAgent);
  if (!ad) return { id: 'gpu', label, state: 'fail', detail: ff
    ? 'Firefox found no usable graphics adapter (its blocklist may turn WebGPU off for this graphics driver). Check about:support, Graphics, or play in Chrome.'
    : linux
      ? 'Chrome found no usable graphics adapter. On Linux Chrome runs WebGPU on Vulkan, so most likely the Vulkan driver for your graphics is missing: install it (mesa-vulkan-drivers on Debian, Ubuntu and Fedora), then restart Chrome. Where chrome://gpu says WebGPU is disabled, also enable it in chrome://flags (#enable-unsafe-webgpu).'
      : windows
        ? 'Chrome found no usable graphics adapter. On Windows Chrome runs WebGPU on Direct3D 12, which older graphics (Intel HD 4000 and older, for one) do not have: the game cannot run on them. On newer graphics, update the graphics driver, then restart Chrome. Dawn Info in chrome://gpu says why each adapter is blocked.'
        : 'Chrome found no usable graphics adapter (blocklisted driver or GPU process crash). Check chrome://gpu.' };
  let info = ad.info ? [ad.info.vendor, ad.info.architecture, ad.info.description].filter(Boolean).join(' ') : '';
  const ffg = ff && windows && !info ? firefoxGraphics() : null;
  if (ffg) info = ffg.name;
  // no BC (PowerVR, Mali): the renderer unpacks the textures (web/src/gpu/dxt.ts), so it plays
  if (!ad.features.has('texture-compression-bc')) {
    return { id: 'gpu', label: `WebGPU${info ? ', ' + info : ''}`, state: 'warn', adapter: info,
      detail: 'This GPU cannot read the game\'s compressed textures, so they are unpacked as the game loads. That needs about 200 MB more memory, and loading screens may pause for a moment.' };
  }
  if (ffg?.integrated) {
    return { id: 'gpu', label: `WebGPU, ${info}`, state: 'warn', adapter: info,
      detail: 'Firefox runs the game on the integrated graphics. If this computer also has a graphics card (NVIDIA or AMD), the game runs much better there: in Windows Settings, System, Display, Graphics, set Firefox to High performance, then restart Firefox. Firefox gives the game the graphics its own windows use; Chrome picks the faster one itself.' };
  }
  return { id: 'gpu', label: `WebGPU${info ? ', ' + info : ''}`, state: 'ok', adapter: info, detail: 'Adapter with BC texture compression.' };
}

/**
 * Firefox on Windows: which graphics the game runs on.  Firefox gives WebGPU the adapter its
 * compositor draws the windows with, whatever powerPreference asks (gfx/wgpu_bindings server.rs:
 * the D3D12 adapter with the compositor's LUID), and its adapter.info is empty.  WebGL's renderer
 * string names the same graphics as a vendor and a class (dom/canvas/SanitizeRenderer.cpp): Intel's
 * integrated graphics become "Intel(R) HD Graphics[ 400]" (Arc cards "Intel(R) Arc(TM) A750
 * Graphics"), and the Ryzen APUs' unnumbered "AMD Radeon(TM) Graphics" "Radeon HD 3200 Graphics".
 */
function firefoxGraphics(): { name: string; integrated: boolean } | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const vendor = /NVIDIA|GeForce|Quadro/.test(r) ? 'NVIDIA' : /Intel/.test(r) ? 'Intel' : /AMD|Radeon/.test(r) ? 'AMD' : null;
    if (!vendor) return null;
    const integrated = vendor === 'Intel' ? !/Arc/.test(r) : vendor === 'AMD' && /Radeon HD 3200/.test(r);
    return { name: `${vendor} graphics${integrated ? ' (integrated)' : ''}`, integrated };
  } catch { return null; }
}

/**
 * Firefox asks the player before it keeps a site's data for good (a prompt by
 * the address bar), and persist() waits for the answer: the check does not.
 * It says so then, and `answer` is the check again once the player answered.
 * Without that promise the data stays until the disk is nearly full, which the
 * page cannot see: Chrome's estimate() tells such a site usage + 10 GiB (since
 * Chrome 133), whatever the disk has.  So that is no warning: backups are the
 * safety net (docs/web/PLAYING.md).
 */
export async function checkStorage(): Promise<Check & { answer?: Promise<Check> }> {
  const label = 'Browser storage';
  try { await navigator.storage.getDirectory(); }
  catch { return { id: 'storage', label, state: 'fail', detail: 'This browser window cannot store files (a guest or private window?). Saves need the origin private file system.' }; }
  const verdict = (persisted: boolean): Check => ({ id: 'storage', label, state: 'ok',
    detail: persisted ? 'Saves and cached game data are kept for good.'
      : `Saves and cached game data are kept until the disk is nearly full, when ${browserName()} may clear them.` });
  const ask = (async () => await navigator.storage.persisted() || await navigator.storage.persist())()
    .catch(() => false);                 // not decisive
  const quick = await Promise.race([ask, new Promise<null>(res => setTimeout(() => res(null), 500))]);
  if (quick !== null) return verdict(quick);
  return { id: 'storage', label, state: 'warn', answer: ask.then(verdict),
    detail: `${upper(browserName())} asks, by the address bar, whether this site may keep its data for good: allow it, so that your saves stay when the disk runs low.` };
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} bytes`;
}
