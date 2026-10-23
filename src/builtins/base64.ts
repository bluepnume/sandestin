// Bytes to and from base64 without Buffer, so JSON mode works in browsers.
type BytesToBase64Options = { readonly bytes : Uint8Array };

export const bytesToBase64 = ({ bytes } : BytesToBase64Options) : string => {
    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

type Base64ToBytesOptions = { readonly text : string };

export const base64ToBytes = ({ text } : Base64ToBytesOptions) : Uint8Array => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};
