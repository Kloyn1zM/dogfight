import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/logs/**'],
  },
  js.configs.recommended,
  {
    files: ['shared/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {},
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['client/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: [
      'server/src/**/*.js',
      'server/test/**/*.js',
      'server/scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
]