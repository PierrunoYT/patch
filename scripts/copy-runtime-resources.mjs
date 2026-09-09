import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(new URL("../src/resources", import.meta.url));
const destination = fileURLToPath(
  new URL("../dist/resources", import.meta.url),
);

await mkdir(destination, { recursive: true });
for (const name of [
  "model-aliases.json5",
  "model-settings.yml",
  "model-metadata.json5",
]) {
  await cp(join(source, name), join(destination, name));
}
