// scripts/format-docs-check.cjs
// Cross-platform docs formatting check for Windows (CommonJS)
const { spawnSync } = require("child_process");
const fs = require("fs");

function getFiles(patterns) {
  const result = spawnSync("git", ["ls-files", ...patterns], {
    encoding: "utf8",
  });
  if (result.error) {
    console.error("Failed to run git:", result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error("git ls-files failed:", result.stderr);
    process.exit(1);
  }
  return result.stdout.split("\n").filter((f) => f && fs.existsSync(f));
}

function runOxfmt(files) {
  const result = spawnSync("oxfmt", ["--check", ...files], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error("Failed to spawn oxfmt:", result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const patterns = ["docs/**/*.md", "docs/**/*.mdx", "README.md"];
const files = getFiles(patterns);
if (files.length === 0) {
  console.log("No docs files found.");
  process.exit(0);
}
runOxfmt(files);
