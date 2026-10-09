import { describe, expect, it } from 'vitest';
import { chromiumSandboxWarning } from './chromium_sandbox';

describe('chromiumSandboxWarning (#22)', () => {
  it('warns only when the app runs with --no-sandbox, and names the fix on Linux', () => {
    expect(chromiumSandboxWarning('linux', false)).toBeNull();
    expect(chromiumSandboxWarning('linux', true)).toMatch(/sandbox is off.*AppArmor.*\.deb package/);
    expect(chromiumSandboxWarning('win32', true)).toMatch(/Start it without that option/);
  });
});
