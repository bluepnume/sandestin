/* eslint-disable unicorn/custom-error-definition -- every class here carries the *remote* error's name on purpose */
export type RemoteErrorOptions = {
    readonly name : string,
    readonly message : string,
    readonly stack ?: string,
    readonly cause ?: unknown,
    // Own enumerable properties the original error carried (a `code`, say).
    readonly properties ?: Readonly<Record<string, unknown>>,
};

// An error that happened on the other side, rebuilt here with the original
// name and message. The local stack points at the call that failed; the
// remote one is attached only when the other side chose to include it.
export class RemoteError extends Error {
    readonly remoteStack : string | undefined;

    constructor({ name, message, stack, cause, properties = {} } : RemoteErrorOptions) {
        super(message, cause === undefined
            ? undefined
            : { cause });

        this.name = name;
        this.remoteStack = stack;
        Object.assign(this, properties);
    }
}

export type HandleErrorOptions = {
    readonly handle : string,
    // The function's name, when known, so the message can say which one.
    readonly name ?: string,
};

const describe = ({ handle, name } : HandleErrorOptions) : string => (name
    ? `Function ${ name } (${ handle })`
    : `Handle ${ handle }`);

// The handle no longer names anything: released, revoked, exhausted by
// `once`, or never known to this side.
export class ReleasedError extends RemoteError {
    constructor(options : HandleErrorOptions) {
        super({ name: 'ReleasedError', message: `${ describe(options) } has been released` });
    }
}

// The inbound gate said no. Deliberately says nothing about why.
export class UnauthorizedError extends RemoteError {
    constructor(options : HandleErrorOptions) {
        super({ name: 'UnauthorizedError', message: `Not authorized to use ${ describe(options) }` });
    }
}
/* eslint-enable unicorn/custom-error-definition */
