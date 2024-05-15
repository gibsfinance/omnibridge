import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import mocha from 'eslint-plugin-mocha'

export default [
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  mocha.configs.flat.recommended,
  {
    // "plugins": [
    //   "node"
    // ],
    // "env": {
    //   "node": true,
    //   "mocha": true
    // },
    "ignores": [
      "node_modules",
      "build",
      "precompiled",
      "coverage",
      "e2e-tests/**/*",
      "deploy",
      ".solcover.js",
    ],
    files: ["**/*.ts"],
    // "globals": {
    //   "artifacts": false,
    //   "contract": false,
    //   "assert": false
    // },
    "rules": {
      "no-plusplus": "off",
      "no-await-in-loop": "off",
      "no-shadow": "off",
      "prefer-destructuring": "off",
      "no-use-before-define": [
        "error",
        {
          "functions": false
        }
      ],
      quotes: ["error", "single"],
      "no-restricted-syntax": "off",
      "node/no-unpublished-require": "off",
      "func-names": "off",
      "import/no-dynamic-require": "off",
      "global-require": "off",
      "no-loop-func": "off",
      "no-console": "off",
      "node/no-missing-require": "off",
      "import/no-unresolved": "off",
      "mocha/no-mocha-arrows": "off",
      "mocha/no-top-level-hooks": "off",
      "mocha/no-setup-in-describe": "off",
      "mocha/max-top-level-suites": ["warn", { "limit": 4 }]
    }
  },
];