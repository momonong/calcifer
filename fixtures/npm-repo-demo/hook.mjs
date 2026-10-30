import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/calcifer-hook-' + process.argv[2], 'synthetic-canary');
process.exit(97);
