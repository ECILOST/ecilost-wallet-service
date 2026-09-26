// ESLint 9 solo lee configuracion plana (eslint.config.*); sin este archivo `npm run lint`
// termina con "couldn't find an eslint.config" y la CI se detiene antes de publicar la imagen.
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },
  ...tseslint.configs['flat/recommended'],
];
