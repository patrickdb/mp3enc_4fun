import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'tools/**'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      complexity: ['error', 20],
      eqeqeq: 'error',
      'no-console': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
    },
  },
  {
    // The CLI entry point is the one place that talks to the terminal.
    files: ['src/cli.ts'],
    rules: { 'no-console': 'off' },
  },
);
