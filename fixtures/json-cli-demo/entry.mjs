import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(input.a - input.b));
