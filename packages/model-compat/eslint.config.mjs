import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Keep vendored source and transpiled upstream assertions reproducible. Their integrity,
  // typechecking and behavioral tests run independently of Cindy's source style rules.
  { ignores: ['dist/', 'src/upstream/**', 'src/__tests__/upstream/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
