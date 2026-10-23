import type { CustomType } from '../custom-types';

// Entries are walked like anything else, so keys and values may be
// functions, promises or other custom types.
export const mapType : CustomType<Map<unknown, unknown>, ReadonlyArray<readonly [ unknown, unknown ]>> = {
    name:   'map',
    test:   value => value instanceof Map,
    encode: ({ value }) => [ ...value ],
    decode: ({ value }) => new Map(value)
};
