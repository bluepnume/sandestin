import type { CustomType } from '../custom-types';

export const dateType : CustomType<Date, string> = {
    name:   'date',
    test:   value => value instanceof Date,
    encode: ({ value }) => value.toISOString(),
    decode: ({ value }) => new Date(value)
};
