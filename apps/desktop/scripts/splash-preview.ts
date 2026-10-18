// Writes the desktop splash as a standalone page, to open in any browser: docs/design-system/splash/eat-the-code.html.
// `?t=1.35` freezes one frame, `?ready=1` hands off to the (absent) UI at that second.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splashHtml } from '@claudio/ui/splash';

const out = fileURLToPath(new URL('../../../docs/design-system/splash/eat-the-code.html', import.meta.url));
writeFileSync(out, `${splashHtml()}\n`);
console.log(out);
