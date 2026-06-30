const SAFE_EXECUTABLE = /^[A-Za-z0-9_./-]+$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function requireExecutable(value) {
  const executable = String(value || "").trim();
  if (!executable || !SAFE_EXECUTABLE.test(executable)) {
    throw new Error(`Unsafe executable: ${value}`);
  }
  return executable;
}

function formatEnv(env = {}) {
  return Object.entries(env).map(([key, value]) => {
    if (!SAFE_ENV_NAME.test(key)) throw new Error(`Unsafe env name: ${key}`);
    return `${key}=${shellQuote(value)}`;
  });
}

function shellFunctionName(executable) {
  return `__tm_agent_launch_${executable.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function buildAgentLaunchCommand({
  executable,
  args = [],
  requiredFlags = [],
  env = {},
} = {}) {
  const exe = requireExecutable(executable);
  const quotedArgs = args.map(shellQuote);
  const envParts = formatEnv(env);
  if (!requiredFlags.length) {
    return [...envParts, exe, ...quotedArgs].join(" ");
  }

  const fn = shellFunctionName(exe);
  const body = [
    `__tm_agent_type="$(type ${exe} 2>/dev/null || true)"`,
    "set --",
    ...requiredFlags.map((flag) => {
      const quotedFlag = shellQuote(flag);
      const probeCommand = [...envParts, exe, '"$__tm_agent_flag"', "--help"].join(" ");
      return `__tm_agent_flag=${quotedFlag}; case "$__tm_agent_type" in *"$__tm_agent_flag"*) ;; *) __tm_agent_probe="$(${probeCommand} 2>&1 >/dev/null || true)"; case "$__tm_agent_probe" in *"cannot be used multiple times"*) ;; *) set -- "$@" "$__tm_agent_flag";; esac;; esac`;
    }),
    `${[...envParts, exe, '"$@"', ...quotedArgs].join(" ")}`,
  ];
  return `${fn}(){ ${body.join("; ")}; }; ${fn}`;
}
