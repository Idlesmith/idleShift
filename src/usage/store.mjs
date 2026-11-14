// Vendored from quota-clock (MIT License, Copyright (c) quota-clock contributors). See NOTICE.
// Only the home-directory lookup is needed here:
// the statusline collectors read the cache files that `quota-clock statusline` writes.
import os from 'node:os';
import path from 'node:path';

export function defaultHome(env = process.env, platform = process.platform) {
  if (env.QUOTA_CLOCK_HOME) return env.QUOTA_CLOCK_HOME;
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'quota-clock');
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'quota-clock');
  return path.join(os.homedir(), '.config', 'quota-clock');
}
