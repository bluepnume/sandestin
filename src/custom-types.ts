import { BUILT_IN_RECORD_TYPES } from './records';

export type CustomTypeEncodeOptions<Value, Context = unknown> = {
    readonly value : Value,
    // The context of the encode this value is part of: the one given to
    // `encode`, or inherited from the handle a call or outcome belongs to.
    readonly context : Context | undefined,
};

export type CustomTypeDecodeOptions<Wire, Context = unknown> = {
    readonly value : Wire,
    readonly context : Context | undefined,
};

// Teaches the codec a type of your own. By value: `encode` returns the data
// to carry and `decode` rebuilds from it. By reference: `encode` returns an
// object of functions bound to the original, which cross as refs, and
// `release` hears once when the far side has let go of all of them.
export type CustomType<Value = unknown, Wire = unknown, Context = unknown> = {
    // The record tag on the wire; must not collide with the built-in ones.
    readonly name : string,
    readonly test : (value : unknown) => boolean,
    readonly encode : (options : CustomTypeEncodeOptions<Value, Context>) => Wire,
    readonly decode : (options : CustomTypeDecodeOptions<Wire, Context>) => Value,
    readonly release ?: (options : CustomTypeEncodeOptions<Value, Context>) => void,
};

// The shape `types` accepts: any CustomType<Value, Wire>, whatever Value and
// Wire are. The codec treats it as the erased form.
export type CustomTypeLike = {
    readonly name : string,
    readonly test : (value : unknown) => boolean,
    readonly encode : (options : CustomTypeEncodeOptions<never, never>) => unknown,
    readonly decode : (options : CustomTypeDecodeOptions<never, never>) => unknown,
    readonly release ?: (options : CustomTypeEncodeOptions<never, never>) => void,
};

export type ValidateCustomTypesOptions = {
    readonly types : ReadonlyArray<CustomTypeLike>,
};

export const validateCustomTypes = ({ types } : ValidateCustomTypesOptions) : void => {
    const seen = new Set<string>();

    for (const type of types) {
        if (BUILT_IN_RECORD_TYPES.has(type.name)) {
            throw new TypeError(`Custom type name "${ type.name }" is reserved by sandestin`);
        }

        if (seen.has(type.name)) {
            throw new TypeError(`Custom type name "${ type.name }" is registered twice`);
        }

        seen.add(type.name);
    }
};
