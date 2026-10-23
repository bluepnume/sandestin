import type { CustomType } from '../custom-types';

import { native } from '../native';

// A MessagePort has no text form: it can only cross a structured-clone
// transport as a transferable, so the type refuses a plain encode.
export const messagePortType : CustomType<MessagePort, never> = {
    name: 'messageport',
    test: value => typeof MessagePort !== 'undefined' && value instanceof MessagePort,

    encode: ({ value, transferable }) => {
        if (!transferable) {
            throw new TypeError('A MessagePort can only be encoded with transferable: true');
        }

        return native({ value, transfer: [ value ] });
    },

    decode: ({ value }) => value
};
