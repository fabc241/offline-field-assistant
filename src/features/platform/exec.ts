import { execFile } from 'node:child_process'

export type Run = (cmd: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>

/** Runs a program without a shell; a non-zero exit is a result, not an error. */
export const run: Run = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') return reject(err)
      resolve({ code: typeof err?.code === 'number' ? err.code : 0, stdout, stderr })
    })
    child.stdin?.end(stdin ?? '')
  })
