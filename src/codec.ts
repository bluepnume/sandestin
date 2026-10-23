import type { CustomType } from './custom-types';
import type { EncodedError, EncodedFunction, EncodedReturned, TaggedRecord } from './records';
import type { AnyFunction, Handle } from './types';

import { ReleasedError, RemoteError, UnauthorizedError } from './errors';
import { isNative } from './native';
import { isPlainObject, isRecord, needsEscaping, record, RECORD_TYPE } from './records';

// Handles produced while encoding one custom-type value, so the owner can be
// told once when the far side has let go of all of them.
export type HandleGroup = {
    readonly handles : ReadonlyArray<Handle>,
    readonly release : () => void,
};

type EncodeWalkOptions = {
    readonly value : unknown,
    // Handed to custom types and remembered by every handle made here.
    readonly context : unknown,
    readonly includeStacks : boolean,
    readonly types : ReadonlyArray<CustomType>,
    // The caller wants `{ wire, transfer }`: custom types may answer with
    // `native(...)`, which stays out of the JSON and goes on the transfer list.
    readonly transferable : boolean,
    // Register a function or promise and get the handle that names it.
    readonly onFunction : (options : { readonly fn : AnyFunction }) => Handle,
    readonly onPromise : (options : { readonly promise : object }) => Handle,
    readonly onGroup : (group : HandleGroup) => void,
    // The handle a ref or remote promise was decoded from, when it came from
    // the side this wire is for; it goes back as that handle, not a new one.
    readonly homeHandle : (options : { readonly target : object }) => Handle | undefined,
};

type EncodeWalkResult = {
    readonly wire : unknown,
    readonly transfer : ReadonlyArray<Transferable>,
};

const ERROR_OWN_KEYS = new Set([ 'name', 'message', 'stack', 'cause' ]);

type Walk = (value : unknown) => unknown;

type EncodeState = Omit<EncodeWalkOptions, 'value'> & {
    // The recursive step, so helpers below can call back into the dispatcher.
    readonly walk : Walk,
    // The same walk, with one custom type left out at the top level only.
    readonly walkSkipping : (options : { readonly value : unknown, readonly skip : CustomType }) => unknown,
    // Input container -> encounter index, so cycles and shared references
    // become `ref` records.
    readonly indexes : Map<object, number>,
    readonly transfer : Array<Transferable>,
    // Handle collectors for custom-type values currently being encoded.
    readonly collectors : Array<Array<Handle>>,
};

type EncodeStep<Value> = {
    readonly value : Value,
    readonly state : EncodeState,
};

type CollectOptions = { readonly handle : Handle, readonly state : EncodeState };

const collect = ({ handle, state } : CollectOptions) : Handle => {
    for (const collector of state.collectors) {
        collector.push(handle);
    }

    return handle;
};

const encodeError = ({ value, state } : EncodeStep<Error>) : TaggedRecord => {
    const properties : Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
        if (!ERROR_OWN_KEYS.has(key)) {
            properties[key] = state.walk((value as unknown as Record<string, unknown>)[key]);
        }
    }

    const encoded : EncodedError = {
        name:    value.name,
        message: value.message,
        properties,
        ...state.includeStacks && value.stack !== undefined
            ? { stack: value.stack }
            : {},
        ...value.cause === undefined
            ? {}
            : { cause: state.walk(value.cause) }
    };

    return record({ type: RECORD_TYPE.ERROR, value: encoded });
};

const remember = ({ value, state } : EncodeStep<object>) : void => {
    state.indexes.set(value, state.indexes.size);
};

const walkObject = ({ value, state } : EncodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    remember({ value, state });

    for (const key of Object.keys(value)) {
        output[key] = state.walk(value[key]);
    }

    return needsEscaping(value)
        ? record({ type: RECORD_TYPE.ESCAPED, value: output })
        : output;
};

const walkArray = ({ value, state } : EncodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    remember({ value, state });

    for (const element of value) {
        output.push(state.walk(element));
    }

    return output;
};

const walkCustom = ({ value, type, state } : EncodeStep<unknown> & { readonly type : CustomType }) : unknown => {
    const handles : Array<Handle> = [];

    state.collectors.push(handles);

    try {
        // The encoded form is walked without this type, so an encoder whose
        // output still passes its own test does not recurse into itself.
        const context = state.context as never;
        const encoded = type.encode({ value, context, transferable: state.transferable });

        // Left to structured clone: no record, nothing walked, just the
        // transfer list to honour.
        if (isNative(encoded)) {
            if (!state.transferable) {
                throw new TypeError(`Custom type "${ type.name }" needs encode({ transferable: true })`);
            }

            state.transfer.push(...encoded.transfer);

            return encoded.value;
        }

        const wire = state.walkSkipping({ value: encoded, skip: type });

        if (type.release) {
            const { release } = type;

            // Nothing to hold means nothing to wait for: tell the owner now.
            state.onGroup({ handles, release: () => release({ value, context }) });
        }

        return record({ type: type.name, value: wire });
    } finally {
        state.collectors.pop();
    }
};

// Anything with a `then` method is a promise here, the same rule `await`
// uses; it is adopted into a native promise on the way in.
const isThenable = (value : unknown) : value is object & PromiseLike<unknown> =>
    typeof value === 'object' && value !== null && typeof (value as { then ?: unknown }).then === 'function';

const dispatch = ({ value, state, skip } : EncodeStep<unknown> & { readonly skip ?: CustomType }) : unknown => {
    const custom = state.types.find(type => type !== skip && type.test(value));

    if (custom) {
        return walkCustom({ value, type: custom, state });
    }

    if (typeof value === 'function') {
        const fn = value as AnyFunction;
        const home = state.homeHandle({ target: fn });

        if (home !== undefined) {
            const returned : EncodedReturned = { kind: 'function', handle: home };

            return record({ type: RECORD_TYPE.RETURNED, value: returned });
        }

        const handle = collect({ handle: state.onFunction({ fn }), state });
        const encoded : EncodedFunction = { handle, name: fn.name };

        return record({ type: RECORD_TYPE.FUNCTION, value: encoded });
    }

    if (isThenable(value)) {
        const home = state.homeHandle({ target: value });

        if (home !== undefined) {
            const returned : EncodedReturned = { kind: 'promise', handle: home };

            return record({ type: RECORD_TYPE.RETURNED, value: returned });
        }

        const handle = collect({ handle: state.onPromise({ promise: value }), state });

        return record({ type: RECORD_TYPE.PROMISE, value: handle });
    }

    if (value instanceof Error) {
        return encodeError({ value, state });
    }

    if (value === undefined) {
        return record({ type: RECORD_TYPE.UNDEFINED, value: null });
    }

    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const index = state.indexes.get(value);

    if (index !== undefined) {
        return record({ type: RECORD_TYPE.REF, value: index });
    }

    if (Array.isArray(value)) {
        return walkArray({ value, state });
    }

    // Anything else (a Date, a Map, a class instance) is passed through and
    // loses its prototype in transit; register a type from `sandestin/types`
    // or one of your own to carry it properly.
    return isPlainObject(value)
        ? walkObject({ value, state })
        : value;
};

export const encodeWalk = ({ value, ...options } : EncodeWalkOptions) : EncodeWalkResult => {
    const state : EncodeState = {
        ...options,
        walk:         input => dispatch({ value: input, state }),
        walkSkipping: ({ value: input, skip }) => dispatch({ value: input, state, skip }),
        indexes:      new Map(),
        transfer:     [],
        collectors:   []
    };

    return { wire: state.walk(value), transfer: state.transfer };
};

type DecodeWalkOptions = {
    readonly wire : unknown,
    readonly context : unknown,
    readonly types : ReadonlyArray<CustomType>,
    readonly onFunction : (options : EncodedFunction) => AnyFunction,
    readonly onPromise : (options : { readonly handle : Handle }) => Promise<unknown>,
    // One of this side's own handles coming back: the original it names.
    readonly onReturned : (options : EncodedReturned) => unknown,
};

type DecodeState = Omit<DecodeWalkOptions, 'wire'> & {
    readonly walk : Walk,
    // Containers in encounter order, the targets of ref records.
    readonly containers : Array<unknown>,
};

type DecodeStep<Wire> = {
    readonly wire : Wire,
    readonly state : DecodeState,
};

const SPECIAL_ERRORS : Readonly<Record<string, (options : { readonly handle : string }) => RemoteError>> = {
    ReleasedError:     options => new ReleasedError(options),
    UnauthorizedError: options => new UnauthorizedError(options)
};

const decodeError = ({ wire, state } : DecodeStep<EncodedError>) : RemoteError => {
    const properties : Record<string, unknown> = {};

    for (const key of Object.keys(wire.properties)) {
        properties[key] = state.walk(wire.properties[key]);
    }

    const cause = wire.cause === undefined
        ? undefined
        : state.walk(wire.cause);

    const special = SPECIAL_ERRORS[wire.name];

    if (special) {
        const error = special({ handle: '' });

        error.message = wire.message;
        Object.assign(error, properties);

        return error;
    }

    return new RemoteError({ name: wire.name, message: wire.message, stack: wire.stack, cause, properties });
};

type TrackOptions = { readonly output : unknown, readonly state : DecodeState };

const track = ({ output, state } : TrackOptions) : void => {
    state.containers.push(output);
};

const unwalkObject = ({ wire, state } : DecodeStep<Record<string, unknown>>) : unknown => {
    const output : Record<string, unknown> = {};

    track({ output, state });

    for (const key of Object.keys(wire)) {
        output[key] = state.walk(wire[key]);
    }

    return output;
};

const unwalkArray = ({ wire, state } : DecodeStep<ReadonlyArray<unknown>>) : unknown => {
    const output : Array<unknown> = [];

    track({ output, state });

    for (const element of wire) {
        output.push(state.walk(element));
    }

    return output;
};

const unwalkRecord = ({ wire, state } : DecodeStep<TaggedRecord>) : unknown => {
    const value = wire.$value;
    const custom = state.types.find(type => type.name === wire.$type);

    if (custom) {
        return custom.decode({ value: state.walk(value), context: state.context });
    }

    switch (wire.$type) {
        case RECORD_TYPE.FUNCTION:
            return state.onFunction(value as EncodedFunction);
        case RECORD_TYPE.PROMISE:
            return state.onPromise({ handle: value as Handle });
        case RECORD_TYPE.RETURNED:
            return state.onReturned(value as EncodedReturned);
        case RECORD_TYPE.ERROR:
            return decodeError({ wire: value as EncodedError, state });
        case RECORD_TYPE.ESCAPED:
            return unwalkObject({ wire: value as Record<string, unknown>, state });
        case RECORD_TYPE.UNDEFINED:
            return undefined;
        case RECORD_TYPE.REF:
            return state.containers[value as number];
        default:
            throw new TypeError(`Unknown record type: ${ wire.$type }`);
    }
};

const undispatch = ({ wire, state } : DecodeStep<unknown>) : unknown => {
    if (typeof wire !== 'object' || wire === null) {
        return wire;
    }

    if (isRecord(wire)) {
        return unwalkRecord({ wire, state });
    }

    if (Array.isArray(wire)) {
        return unwalkArray({ wire, state });
    }

    // A value a custom type left native arrives only from a transferable
    // encode over a structured-clone transport; it is already what it should be.
    return isPlainObject(wire)
        ? unwalkObject({ wire, state })
        : wire;
};

export const decodeWalk = ({ wire, ...options } : DecodeWalkOptions) : unknown => {
    const state : DecodeState = {
        ...options,
        walk:       input => undispatch({ wire: input, state }),
        containers: []
    };

    return state.walk(wire);
};
