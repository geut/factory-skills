import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [nkzw],
  ignorePatterns: ['analysis/**', 'skills/**/*.py', 'skills/**/*.mjs'],
  // The component gallery's client script runs in the browser.
  overrides: [{ env: { browser: true }, files: ['src/stories/assets/*.js'] }],
});
