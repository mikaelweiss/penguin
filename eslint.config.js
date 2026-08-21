import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  ...nx.configs["flat/base"],
  {
    ignores: ["**/node_modules/**", "packages/engine/examples/**"],
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
          allow: [],
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
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];
