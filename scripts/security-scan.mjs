import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.startsWith('contracts/settings/Devnet.toml'))
  .filter((file) => !/(^|\/)(test|tests|reference)(\/|$)/.test(file))
  .filter((file) => file !== 'apps/api/scripts/smoke-vercel.mjs');

const patterns = [
  { name: 'private key', re: /(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC)\s*[:=]\s*["']?[0-9a-f]{64,}["']?/i },
  { name: 'JWT/credential assignment', re: /(?:JWT_SECRET|CRON_SECRET|DATABASE_URL|API_KEY)\s*[:=]\s*["'][^"']{16,}["']/i },
];

const findings = [];
for (const file of tracked) {
  try {
    const source = readFileSync(file, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      for (const { name, re } of patterns) {
        if (re.test(line)) findings.push(`${file}: possible ${name}`);
      }
    }
  } catch {
    continue;
  }
}

if (findings.length) {
  console.error('Potential secrets found in tracked files:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Secret scan passed (${tracked.length} tracked files checked).`);
