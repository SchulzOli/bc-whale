import { exec } from "./exec.js";

/**
 * Secrets are protected with Windows DPAPI (current user) through Windows PowerShell,
 * so nothing is ever stored in plain text and no extra native module is required.
 * Secrets are passed via stdin, never on the command line.
 */
async function ps(script: string, input: string, signal?: AbortSignal): Promise<string> {
  if (process.platform !== "win32") throw new Error("DPAPI secret storage is only available on Windows.");
  // When called from PowerShell 7, the inherited PSModulePath breaks module autoloading in Windows PowerShell 5.1.
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  const env = { PSModulePath: `${sysRoot}\\system32\\WindowsPowerShell\\v1.0\\Modules;${process.env.ProgramFiles ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules` };
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input, stream: false, env, signal });
  if (r.terminationError) throw new Error(r.terminationError);
  signal?.throwIfAborted();
  if (r.exitCode !== 0) throw new Error(`PowerShell failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function protectSecret(plain: string): Promise<string> {
  return ps("$s=[Console]::In.ReadToEnd(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString", plain);
}

export function unprotectSecret(blob: string, signal?: AbortSignal): Promise<string> {
  return ps(
    "$b=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString $b; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
    blob,
    signal,
  );
}

/**
 * Encrypt with an explicit AES key (format understood by the BC generic image:
 * env securePassword + passwordKeyFile).
 */
export function encryptWithKey(plain: string, key: Buffer): Promise<string> {
  const input = JSON.stringify({ p: plain, k: [...key] });
  return ps("$i=[Console]::In.ReadToEnd() | ConvertFrom-Json; ConvertTo-SecureString $i.p -AsPlainText -Force | ConvertFrom-SecureString -Key ([byte[]]$i.k)", input);
}

export function generatePassword(length = 20): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const special = "!#%+-_=";
  const all = upper + lower + digits + special;
  const rnd = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [rnd(upper), rnd(lower), rnd(digits), rnd(special)];
  while (chars.length < length) chars.push(rnd(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
