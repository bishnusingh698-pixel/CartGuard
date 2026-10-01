/**
 * Fails when a translation catalog drifts from the English source of truth.
 *
 * English is the fallback at runtime, so a missing key is not a crash — it is
 * an English sentence appearing in the middle of a German page. That is easy to
 * miss by hand and obvious to merchants, so it is checked in CI instead.
 *
 * Run directly with `npm run check:locales`; `npm test` runs it too.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "i18n", "messages");
const SOURCE_LANGUAGE = "en.json";

/** `{name}` placeholders that must survive translation. */
function placeholdersOf(template) {
  return [...String(template).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

/**
 * Flattened leaf strings of a catalog, dotted paths as keys. Groups are objects,
 * so a nested `{ "a": { "b": "x" } }` becomes `"a.b"`.
 */
function flatten(node, prefix = "") {
  const out = new Map();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") for (const [child, text] of flatten(value, path)) out.set(child, text);
    else out.set(path, value);
  }
  return out;
}

function load(file) {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
}

export function checkLocales() {
  const source = flatten(load(SOURCE_LANGUAGE));
  const problems = [];

  for (const file of readdirSync(MESSAGES_DIR).filter((name) => name.endsWith(".json") && name !== SOURCE_LANGUAGE)) {
    const language = file.replace(/\.json$/, "");
    const catalog = flatten(load(file));

    for (const key of source.keys()) {
      if (!catalog.has(key)) {
        problems.push(`${language}: missing key "${key}"`);
        continue;
      }
      if (typeof catalog.get(key) !== "string" || catalog.get(key).trim() === "") {
        problems.push(`${language}: "${key}" is empty or not a string`);
        continue;
      }
      const expected = placeholdersOf(source.get(key));
      const actual = placeholdersOf(catalog.get(key));
      const missing = expected.filter((name) => !actual.includes(name));
      const extra = actual.filter((name) => !expected.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        problems.push(
          `${language}: "${key}" placeholders differ (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
        );
      }
    }

    for (const key of catalog.keys()) {
      if (!source.has(key)) problems.push(`${language}: key "${key}" is not in ${SOURCE_LANGUAGE}`);
    }
  }

  return { sourceCount: source.size, problems };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const { sourceCount, problems } = checkLocales();
  if (problems.length > 0) {
    console.error(`\nTranslation check failed. ${problems.length} problem(s):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    process.exit(1);
  }
  console.log(`Translations OK: every catalog matches the ${sourceCount} English keys.`);
}