import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const exceptions = JSON.parse(readFileSync(new URL('../security/audit-exceptions.json', import.meta.url), 'utf8'));
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr || audit.stdout || 'npm audit produced no JSON output.\n');
  process.exit(2);
}

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const today = new Date().toISOString().slice(0, 10);
const blocked = [];
const accepted = [];

for (const [name, finding] of Object.entries(report.vulnerabilities ?? {})) {
  if ((severityRank[finding.severity] ?? 0) < severityRank.high) continue;
  const exception = exceptions[name];
  if (exception?.owner && exception?.rationale && exception?.compensatingControl && exception.expires >= today) {
    accepted.push(`${name} (${finding.severity}, exception expires ${exception.expires})`);
  } else {
    blocked.push(`${name} (${finding.severity})`);
  }
}

for (const line of accepted) console.warn(`Accepted: ${line}`);
if (blocked.length) {
  console.error('Unaccepted high/critical production advisories:');
  for (const line of blocked) console.error(`- ${line}`);
  process.exit(1);
}
console.log(`Audit policy passed: ${report.metadata?.vulnerabilities?.total ?? 0} findings, no unaccepted high/critical advisories.`);
