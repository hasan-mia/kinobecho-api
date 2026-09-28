import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'prisma/generated/'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      ...tseslint.configs.recommended,
      prettierConfig,
    ],
    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        ecmaVersion: 2022,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
