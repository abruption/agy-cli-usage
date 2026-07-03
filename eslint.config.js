// Minimal flat ESLint config for a small TypeScript CLI: catches real bugs
// (unused vars/imports, obvious type mistakes) without imposing a large
// opinionated style regime. See CONTRIBUTING-ish note in CLAUDE.md.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // Allow a leading-underscore escape hatch for intentionally-unused
      // params/vars (e.g. destructured args kept for readability).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The codebase deliberately uses `any` in a couple of narrow spots
      // (e.g. dynamically-imported optional deps like node-pty, which have
      // no static types available at build time) — don't fight that pattern.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
