import nkzw from "@nkzw/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [nkzw],
  ignorePatterns: ["analysis/**", "skills/**/*.py", "skills/**/*.mjs"],
});
