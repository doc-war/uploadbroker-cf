import { readFile } from 'node:fs/promises';
import { parse, printParseErrorCode } from 'jsonc-parser';
export async function readConfig(path = 'deploy/wrangler.jsonc') {
  const errors = [];
  const value = parse(await readFile(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`invalid ${path}: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
  return value;
}
