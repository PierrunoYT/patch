import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Windows runners report their temp folder with an 8.3 short name (C:\Users\RUNNER~1). The app resolves projects to
// their long real path, so tests that compare paths use the same form from the start.
if (process.platform === 'win32') {
  const real = realpathSync.native(tmpdir());
  process.env.TEMP = real;
  process.env.TMP = real;
}
