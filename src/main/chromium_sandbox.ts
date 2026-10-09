// electron-builder's AppImage launcher (AppRun) starts the app with --no-sandbox when `unshare -Ur true` fails, that
// is when unprivileged user namespaces are unavailable: Ubuntu 23.10 and later restrict them through AppArmor, and
// an AppImage cannot carry the setuid sandbox helper either. The app then runs, but Chromium's sandbox is off for
// every renderer, including the page that shows model output (#22). The deb installs an AppArmor profile instead.
export function chromiumSandboxWarning(platform: NodeJS.Platform, noSandbox: boolean): string | null {
  if (!noSandbox) return null;
  return platform === 'linux'
    ? "Chromium's sandbox is off: this system does not let Patch use user namespaces, so it was started with --no-sandbox (the AppImage does this on Ubuntu 23.10 and later, which restrict them through AppArmor). Install the .deb package instead, which adds an AppArmor profile for Patch."
    : "Chromium's sandbox is off: Patch was started with --no-sandbox. Start it without that option.";
}
