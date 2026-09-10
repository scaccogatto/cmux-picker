import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/test-results/**', '**/playwright-report/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // demo/serve.mjs is a plain Node script outside tsconfig's `types: ["node"]`, so its
  // Node-provided globals need declaring here for no-undef.
  { files: ['demo/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } },
)
