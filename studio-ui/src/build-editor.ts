/**
 * Bundle the browser structured-editor module (src/client/spec-editor.ts, which
 * imports @crewhaus/spec-forms) into a single self-contained JS string the
 * studio-ui serves at /spec-editor.js. This is studio-ui's "light build step" —
 * the rest of the SPA stays a build-free string (getStudioJs); only the heavy
 * shared-package editor is bundled.
 *
 * Uses Bun.build (server-side only). The start script bundles once at boot and
 * caches the result; a production embed can call this and serve the string from
 * its own route.
 */
export async function buildSpecEditorBundle(): Promise<string> {
  const entry = new URL("./client/spec-editor.ts", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!result.success) {
    const detail = result.logs.map((l) => String(l)).join("\n");
    throw new Error(`spec-editor bundle failed:\n${detail}`);
  }
  const out = result.outputs[0];
  if (!out) throw new Error("spec-editor bundle produced no output");
  return await out.text();
}
