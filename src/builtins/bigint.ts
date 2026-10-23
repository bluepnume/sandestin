import type { CustomType } from '../custom-types';

export const bigintType : CustomType<bigint, string> = {
    name:   'bigint',
    test:   value => typeof value === 'bigint',
    encode: ({ value }) => value.toString(),
    decode: ({ value }) => BigInt(value)
};
