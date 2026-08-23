import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  ...nx.configs["flat/base"],
  {
    ignores: ["**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: {
      "@nx": nx,
    },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: false,
          allowCircularSelfDependency: false,
          allow: ["penguin"],
          depConstraints: [
            {
              sourceTag: "scope:engine",
              onlyDependOnLibsWithTags: ["scope:engine"],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/engine/src/core/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "**/host*", "**/catalog/**", "**/paths*", "**/run*", "**/trace*"],
              message: "core imports only zod and itself",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/engine/src/catalog/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/host*", "**/run*", "**/trace*"],
              message: "catalog depends only on core and paths",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/engine/src/host.ts",
      "packages/engine/src/paths.ts",
      "packages/engine/src/config.ts",
      "packages/engine/src/trace.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/catalog/**"],
              message: "only run.ts orchestrates the catalog",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/engine/src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/host*", "**/catalog/**", "**/run*", "**/trace*", "**/config*"],
              message: "builtin adapters depend only on core",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];
