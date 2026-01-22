/**
 * Type declarations for node-7z
 * Extends the existing @types/node-7z package
 */

declare module 'node-7z' {
  import { EventEmitter } from 'events';

  export interface SevenZipOptions {
    $bin?: string;
    recursive?: boolean;
    password?: string;
    method?: string[];
    charset?: string;
  }

  export interface SevenZipStream extends EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export class Seven {
    static extractFull(
      archive: string,
      dest: string,
      options?: SevenZipOptions
    ): SevenZipStream;

    static add(
      archive: string,
      files: string | string[],
      options?: SevenZipOptions
    ): SevenZipStream;

    static list(archive: string, options?: SevenZipOptions): SevenZipStream;

    static test(archive: string, options?: SevenZipOptions): SevenZipStream;
  }

  export default Seven;
}
