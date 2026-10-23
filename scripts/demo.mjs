#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'git-atomic-demo-'));
const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: true });

run('git', ['init']);
run('git', ['config', 'user.name', 'Demo']);
run('git', ['config', 'user.email', 'demo@example.com']);
run('git', ['config', 'commit.gpgsign', 'false']);

await writeFile(join(dir, 'math.ts'), `export function add(a:number,b:number){return a+b;}\nexport function sub(a:number,b:number){return a-b;}\n`);
await writeFile(join(dir, 'index.ts'), `import {add} from './math.js';\nexport const compute = (n:number)=>add(n,1);\n`);
run('git', ['add', '-A']);
run('git', ['commit', '-m', 'init']);

await writeFile(join(dir, 'math.ts'), `export function add(a:number,b:number){return a+b;}\nexport function sub(a:number,b:number){return a-b;}\nexport function mul(a:number,b:number){return a*b;}\n`);
await writeFile(join(dir, 'index.ts'), `import {add,mul} from './math.js';\nexport const compute = (n:number)=>mul(add(n,1),2);\nexport const label = (n:number)=>String(n);\n`);
await writeFile(join(dir, 'math.test.ts'), `import {mul,add} from './math.js';\nif(mul(2,3)!==6)throw new Error('bad');\nif(add(1,1)!==2)throw new Error('bad');\n`);

console.log('\n--- running git-atomic ---\n');
spawnSync('node', [join(process.cwd(), 'dist/cli.js'), '--dry-run', '--check', 'node --version'], { cwd: dir, stdio: 'inherit' });
