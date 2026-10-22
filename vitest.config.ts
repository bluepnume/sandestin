import { vitestConfig } from 'cugel-scripts/vitest';

export default vitestConfig({
    root:              import.meta.dirname,
    browser:           true,
    coverageThreshold: 95,
    coverageExclude:   [ 'src/testing/**' ]
});
