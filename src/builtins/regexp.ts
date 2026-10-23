import type { CustomType } from '../custom-types';

export const regExpType : CustomType<RegExp, { source : string, flags : string }> = {
    name:   'regexp',
    test:   value => value instanceof RegExp,
    encode: ({ value }) => ({ source: value.source, flags: value.flags }),
    // eslint-disable-next-line security/detect-non-literal-regexp -- rebuilding a RegExp the other side sent
    decode: ({ value }) => new RegExp(value.source, value.flags)
};
