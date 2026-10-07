declare module 'jsfive' {
  export class File {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(buffer: ArrayBuffer, filename?: string);
    keys: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(path: string): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attrs: Record<string, any>;
  }
}
