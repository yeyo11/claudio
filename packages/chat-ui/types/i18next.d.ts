// This package's own compile sees only its namespaces and @claudio/ui's, which proves it reads nothing of the app's.
// Imported by no module: the app's compile declares the full tree in apps/web/src/i18n/index.ts.
import 'i18next';
import type { uiEn } from '@claudio/ui/i18n/resources';
import type { chatUiEn } from '../src/locales';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof uiEn & typeof chatUiEn;
  }
}
