const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.mbtiles'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Los scripts sueltos (config raíz, etc.) que todavía son
    // CommonJS plano — sourceType/globals de Node para que "require"/
    // "module"/"console" no se marquen como no-definidos.
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Aplica a todo .ts/.tsx del monorepo (packages/apps con hooks de
    // React) — inofensivo en archivos sin hooks, así que no hace
    // falta acotarlo carpeta por carpeta.
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
