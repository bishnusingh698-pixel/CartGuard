// Generates generated/api.ts from Shopify's real Function schema.
// schema.graphql comes from `npm run function:schema` (run from the app root)
// and should be committed. If it's missing, typegen is skipped instead of
// failing the build: src/run.ts doesn't depend on the generated types.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "schema.graphql"))) {
  console.warn(
    "[cartguard-validator] schema.graphql not found, skipping type generation. " +
      "Run `npm run function:schema` from the app root to download it.",
  );
  process.exit(0);
}

const result = spawnSync("npx", ["graphql-codegen", "--config", "codegen.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
