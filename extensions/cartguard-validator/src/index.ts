/**
 * CartGuard Validator — module entrypoint.
 *
 * The Shopify CLI's function pipeline bundles `src/index.ts` with esbuild and
 * compiles it to `dist/index.wasm` via Javy, so this file is the conventional
 * entry that re-exports the `run` export (pinned in shopify.extension.toml)
 * from the implementation module. Keep the actual rule logic in run.ts.
 */
export { run, default } from "./run";
