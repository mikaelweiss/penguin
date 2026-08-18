import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  ...nx.configs["flat/base"],
  {
    ignores: ["**/node_modules/**", "packages/engine/examples/**"],
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
];
