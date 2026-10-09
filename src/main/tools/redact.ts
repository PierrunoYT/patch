// Secrets that show up in tool results (a `cat .env`, a read of a key file, a command that prints a token) are
// replaced before the text reaches the model, the transcript or the saved chat. The patterns are well-known token
// formats, passwords in URLs, plus quoted or .env-style values of credential-named variables; ordinary code such as
// `token = getToken()` is left alone.

export const REDACTION_MARK = '[REDACTED:_____]';

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // password = "hunter2hunter2", "api_key": "…", client_secret: '…' (quoted values only)
  /(?<=\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[=:]\s*["'])[^\s"']{8,}(?=["'])/gi,
  // .env style: DB_PASSWORD=value, STRIPE_SECRET_KEY=value (whole line, upper case names)
  /(?<=^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?)[^\s"'$(){}]{8,}/gm,
];

// The password in a URL's user info: postgres://admin:hunter2@db/prod, mongodb+srv://user:P@ss@cluster/db,
// redis://:secret@cache:6379. The password runs to the last @ before the host, so an unescaped @ in it is covered.
// Scheme, user and host stay readable. Every part is bounded and the match starts at `scheme://`, so a long line
// (a minified file, base64) costs linear time: redaction runs on the main process for every tool result (#122).
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@'"`<>]{0,256}:)([^\s/'"`<>]{1,512})(@[^\s@/'"`<>]{1,256})/gi;

// A private key cut off by truncation or split across reads of a command's output (#253): the part after a BEGIN with
// no END, and the part before an END with no BEGIN. Applied after whole keys are replaced, so these only see halves.
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const KEY_TAIL = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/;
const KEY_HEAD = /^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTION_MARK);
  out = out.replace(KEY_HEAD, REDACTION_MARK).replace(KEY_TAIL, REDACTION_MARK);
  return out.replace(URL_PASSWORD, `$1${REDACTION_MARK}$3`);
}

// Redacts text that arrives in pieces (a command's live output). A private key whose BEGIN came in an earlier piece
// is masked until its END arrives, so its middle lines are never shown either.
export function streamRedactor(): (chunk: string) => string {
  let insideKey = false;
  return (chunk) => {
    let text = chunk;
    let prefix = '';
    if (insideKey) {
      const end = KEY_END.exec(text);
      if (!end) return REDACTION_MARK;
      prefix = REDACTION_MARK;
      text = text.slice(end.index + end[0].length);
      insideKey = false;
    }
    const begins = [...text.matchAll(new RegExp(KEY_BEGIN, 'g'))].at(-1);
    if (begins && !KEY_END.test(text.slice(begins.index))) insideKey = true;
    return prefix + redactSecrets(text);
  };
}

export function containsRedaction(text: string): boolean {
  return text.includes(REDACTION_MARK);
}
