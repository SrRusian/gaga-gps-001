declare module 'app-info-parser/src/apk' {
  interface ApkManifest {
    package?: string;
    versionCode?: string | number;
    versionName?: string;
  }

  class ApkParser {
    constructor(filePath: string);
    parse(): Promise<ApkManifest>;
  }

  export = ApkParser;
}
