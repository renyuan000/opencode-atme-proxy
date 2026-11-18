import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tsc = "node_modules/typescript/bin/tsc";

if (existsSync(tsc)) {
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    stdio: "inherit",
  });
  if ((result.status ?? 1) === 0) process.exit(0);
  if (existsSync("dist/cli.js")) {
    console.warn(
      "[atme-proxy] build failed; using the prebuilt dist/ shipped with the package",
    );
    process.exit(0);
  }
  process.exit(result.status ?? 1);
}

if (existsSync("dist/cli.js")) {
  console.log("[atme-proxy] tsc not found; using prebuilt dist");
  process.exit(0);
}

console.error(
  "[atme-proxy] no tsc and no prebuilt dist. Run: npm install && npm run build",
);
process.exit(1);
