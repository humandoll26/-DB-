import { randomBytes, scryptSync } from 'node:crypto';
// stdin経由。コマンド引数やシェル履歴にパスワードを残さない。
process.stderr.write('パスワードを入力してください（12文字以上、入力は表示されません）: ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let password = '';
process.stdin.on('data', chunk => {
  for (const c of chunk.toString()) {
    if (c === '\u0003') process.exit(1);
    if (c === '\r' || c === '\n') {
      if (password.length < 12) { process.stderr.write('\n12文字以上必要です\n'); process.exit(1); }
      const salt = randomBytes(16).toString('hex');
      process.stdout.write(`\nAPP_PASSWORD_HASH=${salt}:${scryptSync(password, salt, 64).toString('hex')}\n`); process.exit(0);
    }
    if (c === '\u007f') password = password.slice(0, -1); else password += c;
  }
});
