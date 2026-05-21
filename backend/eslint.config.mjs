// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "prisma/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Allow leading-underscore unused args/vars (common pattern for ignored args).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Prisma rows + req.body come in as `any` from JSON — too noisy as errors.
      "@typescript-eslint/no-explicit-any": "off",
      // `_req`, `_res` and `void` expressions are common in Express handlers.
      "@typescript-eslint/no-empty-function": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Tests are allowed looser typing.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
