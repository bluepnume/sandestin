import type { CustomType } from '../custom-types';

export const setType : CustomType<Set<unknown>, ReadonlyArray<unknown>> = {
    name:   'set',
    test:   value => value instanceof Set,
    encode: ({ value }) => [ ...value ],
    decode: ({ value }) => new Set(value)
};
