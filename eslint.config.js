const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

const rules = {
  eqeqeq: ['error', 'always'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-console': 'off',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    // Серверний код (Node.js, CommonJS)
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules,
  },
  {
    // Клієнтський код (браузер)
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules,
  },
  prettier,
];
