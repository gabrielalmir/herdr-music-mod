import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig([
  { ignores: ["**/vault-crypto.js"] },
  {
    files: ["mods/**/*.js", "tests/**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    plugins: { "@stylistic": stylistic },
    rules: {
      curly: ["error", "all"],
      "one-var": ["error", "never"],
      "max-statements-per-line": ["error", { max: 1 }],
      "@stylistic/indent": ["error", 2],
      "@stylistic/comma-spacing": "error",
      "@stylistic/keyword-spacing": "error",
      "@stylistic/space-before-blocks": "error",
      "@stylistic/space-infix-ops": "error",
    },
  },
  {
    files: ["mods/**/*.js"],
    languageOptions: { globals: { fetch: "readonly", process: "readonly" } },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { console: "readonly" } },
  },
]);
