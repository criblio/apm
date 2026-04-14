import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // We use the canonical async-fetch-in-useEffect pattern (set loading,
      // await, set result on resolve, clear on finally) with a `cancelled`
      // flag to neutralize StrictMode double-mounts. The new
      // set-state-in-effect rule flags every legitimate fetch effect, and
      // its recommended alternative is "use a framework data layer" — out
      // of scope for this app.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
