import { readFileSync } from 'node:fs';
import { listTasks, stats } from './taskboard.mjs';
const tasks = JSON.parse(readFileSync(new URL('../data/tasks.json', import.meta.url), 'utf8'));
const [command = 'list', ...args] = process.argv.slice(2);
const get = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (command === 'list') console.log(JSON.stringify(listTasks(tasks, {status: get('--status'), before: get('--before')})));
else if (command === 'stats') console.log(JSON.stringify(stats(tasks)));
else { console.error('Unknown command'); process.exitCode = 2; }
