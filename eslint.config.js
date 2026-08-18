import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

const engineAuthor = {
  name: "@mikaelweiss/penguin-engine",
  message: "import the author API from @mikaelweiss/penguin-engine only in apps/cli/src/index.ts",
};
const engineCatalog = {
  name: "@mikaelweiss/penguin-engine/catalog",
  message: "viewer imports @mikaelweiss/penguin-engine/protocol",
};
const engineRun = {
  name: "@mikaelweiss/penguin-engine/run",
  message: "viewer imports @mikaelweiss/penguin-engine/protocol",
};
const engineBare = {
  name: "@mikaelweiss/penguin-engine",
  message: "viewer imports @mikaelweiss/penguin-engine/protocol",
};

export default [
  ...nx.configs["flat/base"],
  {
    ignores: ["**/node_modules/**", "packages/engine/examples/**", "src/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@nx": nx,
    },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: false,
          allowCircularSelfDependency: false,
          allow: [],
          depConstraints: [
            {
              sourceTag: "scope:engine",
              onlyDependOnLibsWithTags: ["scope:engine"],
            },
            {
              sourceTag: "scope:viewer",
              onlyDependOnLibsWithTags: ["scope:engine", "scope:viewer"],
            },
            {
              sourceTag: "scope:cli",
              onlyDependOnLibsWithTags: ["scope:engine", "scope:viewer", "scope:cli"],
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/viewer/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [engineBare, engineCatalog, engineRun],
        },
      ],
    },
  },
  {
    files: ["apps/cli/src/**/*.{ts,tsx}"],
    ignores: ["apps/cli/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [engineAuthor],
        },
      ],
    },
  },
  {
    files: ["apps/cli/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@mikaelweiss/penguin-engine/catalog",
              message: "index.ts re-exports the author API from @mikaelweiss/penguin-engine",
            },
            {
              name: "@mikaelweiss/penguin-engine/run",
              message: "index.ts re-exports the author API from @mikaelweiss/penguin-engine",
            },
            {
              name: "@mikaelweiss/penguin-engine/protocol",
              message: "index.ts re-exports the author API from @mikaelweiss/penguin-engine",
            },
          ],
        },
      ],
    },
  },
];
