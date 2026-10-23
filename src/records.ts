// Every special value crosses as one record shape. A user object that happens
// to carry a `$type` key is wrapped in an `escaped` record so it round-trips.
const RECORD_KEY = '$type';

const RECORD_VALUE_KEY = '$value';

export const RECORD_TYPE = {
    FUNCTION:  'function',
    PROMISE:   'promise',
    ERROR:     'error',
    ESCAPED:   'escaped',
    UNDEFINED: 'undefined',
    // A second occurrence of a container already emitted: cycles and shared
    // references.
    REF:       'ref',
    // A ref or remote promise sent back to the side it came from: names the
    // owner's own handle, so the owner gets its original back.
    RETURNED:  'returned'
} as const;

export const BUILT_IN_RECORD_TYPES : ReadonlySet<string> = new Set(Object.values(RECORD_TYPE));

export type TaggedRecord<Type extends string = string, Value = unknown> = {
    readonly [ RECORD_KEY ] : Type,
    readonly [ RECORD_VALUE_KEY ] : Value,
};

type RecordOptions<Type extends string, Value> = {
    readonly type : Type,
    readonly value : Value,
};

export const record = <Type extends string, Value>(
    { type, value } : RecordOptions<Type, Value>
) : TaggedRecord<Type, Value> => ({
    [ RECORD_KEY ]:       type,
    [ RECORD_VALUE_KEY ]: value
});

export const isRecord = (value : unknown) : value is TaggedRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.hasOwn(value, RECORD_KEY) && Object.hasOwn(value, RECORD_VALUE_KEY) &&
    typeof (value as { [ RECORD_KEY ] : unknown })[RECORD_KEY] === 'string';

// A user object that would be mistaken for a record on the far side.
export const needsEscaping = (value : object) : boolean => Object.hasOwn(value, RECORD_KEY);

// What a function record carries: the handle, and the name for humans.
export type EncodedFunction = {
    readonly handle : string,
    readonly name : string,
};

export type EncodedReturned = {
    readonly kind : 'function' | 'promise',
    readonly handle : string,
};

export type EncodedError = {
    readonly name : string,
    readonly message : string,
    readonly stack ?: string,
    readonly cause ?: unknown,
    readonly properties : Readonly<Record<string, unknown>>,
};

export const isPlainObject = (value : unknown) : value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const proto : unknown = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null;
};
