import { describe, expect, it } from 'vitest';
import { isCommandAllowed, parseAllowedCommands } from './allowed_commands';

const allowed = 'npm test\n# comments and blank lines are ignored\n\ngit   status\nnpm run lint';

describe('parseAllowedCommands', () => {
  it('drops blank lines and comments and collapses whitespace', () => {
    expect(parseAllowedCommands(allowed)).toEqual(['npm test', 'git status', 'npm run lint']);
  });
});

describe('isCommandAllowed', () => {
  it('allows an allowed command with or without arguments', () => {
    expect(isCommandAllowed('npm test', allowed)).toBe(true);
    expect(isCommandAllowed('  npm   test -- --watch=false ', allowed)).toBe(true);
    expect(isCommandAllowed('git status', allowed)).toBe(true);
  });

  it('matches whole words only', () => {
    expect(isCommandAllowed('npm testing', allowed)).toBe(false);
    expect(isCommandAllowed('npm', allowed)).toBe(false);
    expect(isCommandAllowed('git statuses', allowed)).toBe(false);
  });

  it('still allows ordinary arguments, including scoped packages, quotes and paths', () => {
    const list = 'npm install\nnpx vitest';
    expect(isCommandAllowed('npm install @types/node --save-dev', list)).toBe(true);
    expect(isCommandAllowed('npx vitest run "src/a b.test.ts" -t "adds numbers"', list)).toBe(true);
    expect(isCommandAllowed('npx vitest run src/main/agent --reporter=verbose', list)).toBe(true);
  });

  it.each([
    // git log/diff/show write any bytes to any path with --output and --format escapes (#233).
    ['git log', 'git log -1 --format=%x65cho%x20pwned --output=/home/u/.bashrc'],
    ['git log', 'git log --output x.sh'],
    ['git log', 'git log "--output=x.sh"'],
    ['git diff', 'git diff --OUTPUT=x'],
    ['git format-patch', 'git format-patch -o ../out HEAD~1'],
    ['git grep', 'git grep -Ocalc foo'],
    ['find', 'find . -name x -exec rm -rf src'],
    ['find', 'find . -delete'],
    ['find', 'find . -fprint ../list'],
    ['sed', 'sed --in-place s/a/b/ file'],
    // PowerShell takes typographic quotes as quotes and passes --output=… on (#265).
    ['git log', 'git log \u201c--output=C:/x/evil\u201d'],
    ['git log', 'git log \u2018--output=evil\u2019'],
    ['git log', 'git log \u201e--output=evil\u201d'],
    ['git log', 'git log \u2014output=evil'],
    // bash drops the backslash.
    ['git log', 'git log --output\\=evil'],
    ['git log', 'git log --out\\put=evil'],
    ['curl', 'curl -\\o evil https://example.com'],
    // Short flags bundled with -o or -O.
    ['curl', 'curl -so evil https://example.com'],
    ['curl', 'curl -sSLo evil https://example.com'],
    ['curl', 'curl -sO https://example.com/x'],
    ['sort', 'sort -uo package.json x'],
    ['git grep', 'git grep -iOcalc foo'],
    ['find', 'find . -name a -o -name b'],
    // Options that run a program or write a file (#275), also abbreviated as GNU getopt accepts them.
    ['rg', 'rg --pre=calc x'],
    ['rg', 'rg --pre calc x'],
    ['sort', 'sort --outp=/home/u/.bashrc a.txt'],
    ['sort', 'sort --o=x a.txt'],
    ['sort', 'sort --compress-program=calc a.txt'],
    ['sed', 'sed --in-pl s/a/b/ src/x.ts'],
    ['tar', 'tar -cf x.tar --to-command=calc .'],
    ['tar', 'tar --checkpoint=1 --checkpoint-action=exec=calc -cf x.tar .'],
    ['tar', 'tar -I calc -cf x.tar .'],
    ['tar', 'tar -xIcalc -f x.tar'],
    ['tar', 'tar --use-compress=calc -cf x.tar .'],
    ['fd', 'fd -x calc'],
    ['fd', 'fd -X calc'],
    ['fd', 'fd --exec-batch calc'],
    ['fd', 'C:\\tools\\fd.exe -x calc'],
    // Script programs take only their exact allowed command: sed's w and e commands write files and run programs.
    ['sed', 'sed -i s/a/b/ src/x.ts'],
    ['sed', 'sed -n w/tmp/x f'],
    ['sed', 'sed -n 1p f'],
    ['awk', 'awk {print} f'],
    ['perl', 'perl -ne print f'],
  ])('asks when %s gets an argument that writes a file or runs a program: %s', (entry, command) => {
    expect(isCommandAllowed(command, entry)).toBe(false);
  });

  it('keeps allowing the same commands with harmless arguments', () => {
    expect(isCommandAllowed('git log -1 --format=%h --stat', 'git log')).toBe(true);
    expect(isCommandAllowed('git diff --stat -- src/output.ts', 'git diff')).toBe(true);
    expect(isCommandAllowed('find . -name "*.ts" -type f', 'find')).toBe(true);
    expect(isCommandAllowed('find . -not -name "*.ts" -follow', 'find')).toBe(true);
    expect(isCommandAllowed('curl -sSL https://example.com', 'curl')).toBe(true);
    expect(isCommandAllowed('git log --oneline -10', 'git log')).toBe(true);
    expect(isCommandAllowed('npx vitest run src\\main\\agent', 'npx vitest')).toBe(true);
    expect(isCommandAllowed('git log --pretty=oneline --topo-order --color', 'git log')).toBe(true);
    expect(isCommandAllowed('rg -i --type ts --context 2 foo src', 'rg')).toBe(true);
    expect(isCommandAllowed('grep -rx foo src', 'grep')).toBe(true);
    expect(isCommandAllowed('fd -e ts -t f src', 'fd')).toBe(true);
    expect(isCommandAllowed('tar -tzf x.tar.gz', 'tar')).toBe(true);
    expect(isCommandAllowed('sort -u -k2 a.txt', 'sort')).toBe(true);
    // The exact allowed command is allowed even when it ends in such an argument: the user wrote it.
    expect(isCommandAllowed('git log --output=log.txt', 'git log --output=log.txt')).toBe(true);
    expect(isCommandAllowed('sed -n 1p f', 'sed -n 1p f')).toBe(true);
  });

  it('rejects commands that are not on the list', () => {
    expect(isCommandAllowed('rm -rf .', allowed)).toBe(false);
    expect(isCommandAllowed('npm install', allowed)).toBe(false);
    expect(isCommandAllowed('anything', '')).toBe(false);
  });

  it.each([
    'npm test && rm -rf .',
    'npm test; rm -rf .',
    'npm test | tee out.txt',
    'npm test & calc',
    'npm test > out.txt',
    'npm test < in.txt',
    'npm test `whoami`',
    'npm test $(whoami)',
    'npm test\nrm -rf .',
    // PowerShell runs these even as arguments of a program.
    'npm test (Remove-Item -Recurse -Force src)',
    'npm test @(Remove-Item src)',
    'npm test {Remove-Item src}',
    'npm test $env:USERPROFILE',
    'npm test ${HOME}',
    // After a real argument the allowed prefix matches, so only the operator check stops these.
    'npm test -- --watch; rm -rf .',
    'npm test ; rm -rf .',
    'npm test -- --x | tee out.txt',
  ])('never allows shell operators: %s', (command) => {
    expect(isCommandAllowed(command, allowed)).toBe(false);
  });
});
