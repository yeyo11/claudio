import { migrateLegacyStorage } from './legacy-storage';

// Imported first by main.tsx: the theme, the language and the motion level read their keys while
// their modules load, so the old keys have to be under their new names before any of them runs.
try {
  migrateLegacyStorage(localStorage);
} catch {
  // Storage blocked: there is nothing to read the old keys from either
}
