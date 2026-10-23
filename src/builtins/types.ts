import type { CustomTypeLike } from '../custom-types';

import { bigintType } from './bigint';
import { bytesType } from './bytes';
import { dateType } from './date';
import { mapType } from './map';
import { messagePortType } from './message-port';
import { regExpType } from './regexp';
import { setType } from './set';

// Everything the codec used to carry on its own, for a caller that wants
// all of it: `sandestin({ types: builtinTypes })`.
export const builtinTypes : ReadonlyArray<CustomTypeLike> = [
    dateType, regExpType, mapType, setType, bigintType, bytesType, messagePortType
];
