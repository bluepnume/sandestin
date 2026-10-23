// What a custom type returns to leave a value out of the wire's JSON and in
// the hands of structured clone: the value itself, untouched, plus whatever
// `postMessage` should transfer rather than copy. Only honoured when the
// caller asked for a transferable encode.
const NATIVE = Symbol('sandestin.native');

export type Native<Value = unknown> = {
    readonly [ NATIVE ] : true,
    readonly value : Value,
    readonly transfer : ReadonlyArray<Transferable>,
};

export type NativeOptions<Value> = {
    readonly value : Value,
    readonly transfer ?: ReadonlyArray<Transferable>,
};

export const native = <Value>({ value, transfer = [] } : NativeOptions<Value>) : Native<Value> =>
    ({ [ NATIVE ]: true, value, transfer });

export const isNative = (value : unknown) : value is Native =>
    typeof value === 'object' && value !== null && (value as { [ NATIVE ] ?: unknown })[NATIVE] === true;
